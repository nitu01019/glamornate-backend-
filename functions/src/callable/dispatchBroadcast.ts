import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import { sanitizeInput } from '../utils/validator';
import { writeAuditLog } from '../utils/audit-log';
import {
  appendBroadcastRecipients,
  filterAlreadyNotified,
  markBroadcastCompleted,
  markBroadcastFailed,
  markBroadcastRunning,
  readBroadcastJob,
  reserveBroadcastJob,
} from '../utils/broadcast-journal';

const logger = createLogger('dispatchBroadcast');

/**
 * Fan-out batch size for Firestore writes. Firestore allows up to 500 writes
 * per batch; we use 50 to match the success-contract test and keep memory low.
 */
export const BROADCAST_FANOUT_BATCH_SIZE = 50;

/**
 * Default time-to-live for broadcast notifications. After `expiresAt` the
 * scheduled `cleanupOldNotifications` job will delete them.
 */
export const DEFAULT_BROADCAST_EXPIRY_DAYS = 30;

const AudienceSchema = z.union([
  z.literal('all'),
  z.object({
    roles: z
      .array(z.enum(['customer', 'spa_owner', 'spa_staff', 'admin']))
      .min(1)
      .max(10)
      .optional(),
  }),
]);

const DispatchBroadcastSchema = z.object({
  /**
   * Optional caller-supplied id. If absent, the function generates one so
   * later callers can retry by echoing it back.
   */
  broadcastId: z.string().min(6).max(128).optional(),
  audience: AudienceSchema,
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(1000),
  imageUrl: z.string().url().max(2000).optional(),
  ctaUrl: z.string().url().max(2000).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export type DispatchBroadcastInput = z.infer<typeof DispatchBroadcastSchema>;

export interface DispatchBroadcastResult {
  success: true;
  broadcastId: string;
  /** True if this call skipped because the id was already processed. */
  alreadyDispatched: boolean;
  /** Number of notifications written by THIS call. */
  dispatched: number;
  /** Cumulative number of recipients recorded in the journal (all calls). */
  totalRecipients: number;
  /** Audience size discovered during fan-out. */
  audienceSize: number;
}

/**
 * `dispatchBroadcast` — admin-only, idempotent, chunked fan-out of a
 * notification to every user matching an audience filter.
 *
 * Contract (see PHASE_4.md §3.4):
 *   - Caller MUST have custom claim `admin: true` OR `role === 'admin'` in
 *     their Firestore user document.
 *   - Each target user receives exactly one notification in the top-level
 *     `notifications` collection with `type: 'broadcast'` and a populated
 *     `expiresAt` (defaults to +30 days).
 *   - Retry-safe: repeat calls with the same `broadcastId` are coalesced via
 *     `broadcast_jobs/{broadcastId}` journal.
 *
 * Error surface (`HttpsError.code`):
 *   - `unauthenticated`   not signed in
 *   - `permission-denied` not an admin
 *   - `invalid-argument`  zod validation failed
 *   - `internal`          journal or fan-out threw
 */
export const dispatchBroadcast = callableOpts({ timeoutSeconds: 540, memory: '512MB', maxInstances: 5 })
  .https.onCall(
    withRateLimit<unknown, DispatchBroadcastResult>(
      { name: 'dispatchBroadcast', windowMs: 60_000, max: 10 },
      async (data, context): Promise<DispatchBroadcastResult> => {
      if (!context.auth) {
        throw new functions.https.HttpsError(
          'unauthenticated',
          'broadcast/unauthenticated',
        );
      }

      // -----------------------------------------------------------------
      // 1. Admin gate
      //    Accept either the `admin: true` custom claim (preferred) or
      //    `role === 'admin'` on the caller's user document (backwards
      //    compatibility with the existing rules helpers).
      // -----------------------------------------------------------------
      await assertAdmin(context);

      // -----------------------------------------------------------------
      // 2. Validate payload
      // -----------------------------------------------------------------
      let input: DispatchBroadcastInput;
      try {
        input = DispatchBroadcastSchema.parse(data);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new functions.https.HttpsError(
            'invalid-argument',
            'broadcast/invalid-payload',
            { errors: error.errors },
          );
        }
        throw new functions.https.HttpsError(
          'invalid-argument',
          'broadcast/invalid-payload',
        );
      }

      const broadcastId =
        input.broadcastId ?? `bcast_${Date.now()}_${randomSuffix()}`;
      const expiryDays = input.expiresInDays ?? DEFAULT_BROADCAST_EXPIRY_DAYS;
      const expiresAt = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
      );

      // -----------------------------------------------------------------
      // 2b. HTML-escape user-supplied free-text fields (title/body).
      // Prevents stored-XSS in notification feeds that render rich text.
      // -----------------------------------------------------------------
      const safeTitle = sanitizeInput(input.title);
      const safeBody = sanitizeInput(input.body);

      // -----------------------------------------------------------------
      // 3. Reserve / load the journal entry
      // -----------------------------------------------------------------
      const reservation = await reserveBroadcastJob({
        broadcastId,
        createdBy: context.auth.uid,
        title: safeTitle,
        body: safeBody,
        imageUrl: input.imageUrl ?? null,
        ctaUrl: input.ctaUrl ?? null,
      });

      const existing =
        reservation.created ? null : reservation.existing ?? null;

      if (existing?.status === 'completed') {
        logger.info('Broadcast already completed — short-circuiting', {
          broadcastId,
        });
        return {
          success: true,
          broadcastId,
          alreadyDispatched: true,
          dispatched: 0,
          totalRecipients: existing.sentCount,
          audienceSize: existing.totalTargets,
        };
      }

      // If another in-flight run exists, we join it — the recipients array
      // serves as the de-dupe set so we will never double-notify.
      const alreadyNotified = existing?.recipients ?? [];

      try {
        // ---------------------------------------------------------------
        // 4. Discover the audience
        // ---------------------------------------------------------------
        const audienceIds = await resolveAudience(input.audience);
        await markBroadcastRunning(broadcastId, audienceIds.length);

        const toNotify = filterAlreadyNotified(audienceIds, alreadyNotified);

        logger.info('Broadcast fan-out begin', {
          broadcastId,
          audienceSize: audienceIds.length,
          alreadyNotified: alreadyNotified.length,
          toNotify: toNotify.length,
        });

        // ---------------------------------------------------------------
        // 5. Write notifications in chunks of BROADCAST_FANOUT_BATCH_SIZE
        // ---------------------------------------------------------------
        const db = admin.firestore();
        let dispatched = 0;

        for (let i = 0; i < toNotify.length; i += BROADCAST_FANOUT_BATCH_SIZE) {
          const slice = toNotify.slice(i, i + BROADCAST_FANOUT_BATCH_SIZE);
          const batch = db.batch();
          for (const userId of slice) {
            const ref = db.collection('notifications').doc();
            batch.set(ref, {
              userId,
              type: 'broadcast',
              title: safeTitle,
              body: safeBody,
              imageUrl: input.imageUrl ?? null,
              ctaUrl: input.ctaUrl ?? null,
              data: { broadcastId },
              read: false,
              readAt: null,
              deliveryStatus: 'delivered',
              sentAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt,
              channels: { push: false, email: false, sms: false },
              broadcastId,
              priority: 'normal',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
          await appendBroadcastRecipients(broadcastId, slice);
          dispatched += slice.length;
        }

        await markBroadcastCompleted(broadcastId);

        const journal = await readBroadcastJob(broadcastId);
        const totalRecipients = journal?.sentCount ?? dispatched;

        logger.info('Broadcast dispatched', {
          broadcastId,
          dispatched,
          totalRecipients,
          audienceSize: audienceIds.length,
        });

        // S4: Audit log — admin action. Records the admin who pushed the
        // broadcast, the audience size, and the message preview so
        // compliance can answer "who sent this to every user?".
        try {
          await writeAuditLog({
            userId: context.auth.uid,
            action: 'broadcast.dispatched',
            entity: { type: 'broadcast', id: broadcastId },
            before: null,
            after: {
              status: 'completed',
              sentCount: totalRecipients,
            },
            metadata: {
              audience: input.audience,
              audienceSize: audienceIds.length,
              dispatchedThisCall: dispatched,
              titlePreview: safeTitle.slice(0, 120),
              bodyPreview: safeBody.slice(0, 200),
              hadImage: Boolean(input.imageUrl),
              hadCta: Boolean(input.ctaUrl),
            },
          });
        } catch (auditError) {
          logger.warn('writeAuditLog failed (dispatchBroadcast)', auditError);
        }

        return {
          success: true,
          broadcastId,
          alreadyDispatched: false,
          dispatched,
          totalRecipients,
          audienceSize: audienceIds.length,
        };
      } catch (error) {
        logger.error('Broadcast dispatch failed', error);
        try {
          await markBroadcastFailed(
            broadcastId,
            error instanceof Error ? error.message : String(error),
          );
        } catch (markError) {
          logger.warn('Failed to record broadcast failure', markError);
        }
        throw handleError(error);
      }
    },
    ),
  );

// ---------------------------------------------------------------------------
// Admin assertion
// ---------------------------------------------------------------------------

async function assertAdmin(
  context: functions.https.CallableContext,
): Promise<void> {
  const token = context.auth?.token ?? {};
  if ((token as Record<string, unknown>).admin === true) {
    return;
  }

  // Fallback: inspect the Firestore user document. This keeps dispatch usable
  // in environments where the `admin` custom claim has not been provisioned
  // but the user document already has `role === 'admin'`.
  const uid = context.auth!.uid;
  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    const role = snap.data()?.role;
    if (role === 'admin') return;
  } catch (error) {
    logger.warn('Admin role lookup failed', error);
  }

  throw new functions.https.HttpsError(
    'permission-denied',
    'broadcast/admin-required',
  );
}

// ---------------------------------------------------------------------------
// Audience resolution
// ---------------------------------------------------------------------------

/**
 * Expand an `audience` filter into the concrete list of userIds that should
 * receive the broadcast. For `'all'` we pull every user doc; for a role
 * filter we issue a `where` query per role.
 *
 * Paginates in 500-doc pages to stay well under the 1 MB document cap.
 */
export async function resolveAudience(
  audience: DispatchBroadcastInput['audience'],
): Promise<string[]> {
  const db = admin.firestore();
  const collected: Set<string> = new Set();

  const pageSize = 500;

  async function pageThrough(
    query: admin.firestore.Query,
  ): Promise<void> {
    let cursor: admin.firestore.QueryDocumentSnapshot | undefined;
    while (true) {
      let q = query.orderBy('__name__').limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) return;
      for (const doc of snap.docs) {
        collected.add(doc.id);
      }
      if (snap.docs.length < pageSize) return;
      cursor = snap.docs[snap.docs.length - 1];
    }
  }

  if (audience === 'all' || !audience) {
    await pageThrough(db.collection('users'));
  } else if (audience.roles && audience.roles.length > 0) {
    // Fan-in per role so we can respect each role's rules allowlist.
    for (const role of audience.roles) {
      await pageThrough(db.collection('users').where('role', '==', role));
    }
  } else {
    await pageThrough(db.collection('users'));
  }

  return Array.from(collected);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
