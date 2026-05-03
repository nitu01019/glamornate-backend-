import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import {
  writeAuditLog,
  hashPII,
  addYearsIso,
  AUDIT_LOG_RETENTION_YEARS,
} from '../utils/audit-log';
import { cascadeDeleteUserData } from '../utils/cascade-delete';

const logger = createLogger('deleteAccount');

/**
 * The exact confirmation string the client must send. We make it long
 * enough that it cannot be accidentally typed by an autofill extension
 * and stable enough that the client can hard-code it.
 */
export const DELETE_CONFIRMATION = 'DELETE MY ACCOUNT';

/**
 * Firebase's own "recent login" threshold for sensitive actions is
 * roughly 5 minutes. We mirror that exactly here so the client UX and
 * the server contract agree.
 */
const RECENT_LOGIN_WINDOW_SECONDS = 5 * 60;

const DeleteAccountSchema = z.object({
  confirmationString: z.literal(DELETE_CONFIRMATION),
});

export type DeleteAccountInput = z.infer<typeof DeleteAccountSchema>;

export interface DeleteAccountSuccess {
  success: true;
  /** true only when the first invocation actually deleted data. */
  alreadyDeleted?: boolean;
  /** Zero-or-more warnings collected while deleting Storage objects. */
  warnings?: string[];
}

/**
 * `deleteAccount` — Play-Store-compliant, cascade-deleting, audit-logged
 * account removal.
 *
 * Contract (see PHASE_3.md §4.1 and §6.1):
 *   • requires `context.auth.uid` AND `context.auth.token.email_verified`
 *   • requires `auth_time` within the last 5 minutes (re-auth freshness)
 *   • validates the confirmation string via Zod
 *   • writes `audit_logs/{auto}` BEFORE any destructive work
 *   • runs `cascadeDeleteUserData` which is itself idempotent and
 *     checkpoints each step in `deletion_jobs/{uid}`
 *   • returns `{ success: true, alreadyDeleted?: boolean }`
 *
 * Error surface (`HttpsError.code`):
 *   • `unauthenticated`        → not signed in / email not verified
 *   • `failed-precondition`    → auth_time too old (requires-recent-login)
 *   • `invalid-argument`       → confirmation string mismatch
 *   • `internal`               → audit-log write failed or cascade threw
 */
export const deleteAccount = callableOpts({
    timeoutSeconds: 540,
    memory: '512MB',
    maxInstances: 10,
    region: 'us-central1',
  })
  .https.onCall(
    withRateLimit(
      { name: 'deleteAccount', windowMs: 60_000, max: 30 },
      async (data, context): Promise<DeleteAccountSuccess> => {
    // ---------------------------------------------------------------
    // 1. Auth gate
    // ---------------------------------------------------------------
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'account/unauthenticated',
      );
    }

    const uid = context.auth.uid;
    const token = context.auth.token ?? {};
    if (token.email_verified !== true) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'account/unauthenticated',
        { reason: 'email_not_verified' },
      );
    }

    // ---------------------------------------------------------------
    // 2. Re-auth recency check
    // ---------------------------------------------------------------
    const authTime = typeof token.auth_time === 'number' ? token.auth_time : 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!authTime || nowSeconds - authTime > RECENT_LOGIN_WINDOW_SECONDS) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'account/requires-recent-login',
      );
    }

    // ---------------------------------------------------------------
    // 3. Validate payload
    // ---------------------------------------------------------------
    try {
      DeleteAccountSchema.parse(data);
    } catch (error) {
      logger.warn('Invalid confirmation string', { uid });
      if (error instanceof z.ZodError) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'account/invalid-confirmation',
          { errors: error.errors },
        );
      }
      throw new functions.https.HttpsError(
        'invalid-argument',
        'account/invalid-confirmation',
      );
    }

    const db = admin.firestore();

    // ---------------------------------------------------------------
    // 4. Idempotent short-circuit — if the journal says we already
    //    finished, return success without touching anything.
    // ---------------------------------------------------------------
    try {
      const journalSnap = await db.collection('deletion_jobs').doc(uid).get();
      if (journalSnap.exists && journalSnap.data()?.status === 'completed') {
        logger.info('deleteAccount called for already-deleted user', { uid });
        return { success: true, alreadyDeleted: true };
      }
    } catch (error) {
      // Journal check is best-effort — if it fails we still proceed
      // and cascadeDeleteUserData will do its own recovery.
      logger.warn('Journal pre-check failed, proceeding', error);
    }

    // ---------------------------------------------------------------
    // 5. Audit log FIRST — if this fails we refuse to delete anything
    // ---------------------------------------------------------------
    const requesterIp = extractIp(context.rawRequest);
    const requesterUa = extractUserAgent(context.rawRequest);

    try {
      const userSnap = await db.collection('users').doc(uid).get();
      const userData = userSnap.data() ?? null;

      await writeAuditLog({
        userId: uid,
        action: 'account_deleted',
        entity: { type: 'user', id: uid },
        before: userData
          ? {
              emailHash: hashPII(
                userData.profile?.email ?? userData.email ?? null,
              ),
              phoneHash: hashPII(
                userData.profile?.phone ?? userData.phone ?? null,
              ),
              role: userData.role ?? null,
              createdAt: userData.createdAt ?? null,
            }
          : null,
        after: null,
        ipAddress: requesterIp,
        userAgent: requesterUa,
        requesterUid: uid,
        metadata: {
          retentionUntil: addYearsIso(AUDIT_LOG_RETENTION_YEARS),
          requestedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      // Audit log failure is terminal — we must not silently delete data.
      logger.error('Audit log write failed — aborting deletion', error);
      throw new functions.https.HttpsError(
        'internal',
        'account/audit-log-failed',
      );
    }

    // ---------------------------------------------------------------
    // 6. Cascade
    // ---------------------------------------------------------------
    try {
      const result = await cascadeDeleteUserData(uid);
      logger.info('Cascade complete', { uid, counts: result.counts });
      return {
        success: true,
        alreadyDeleted: !result.performedWork,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    } catch (error) {
      logger.error('Cascade deletion failed', error);
      throw handleError(error);
    }
      },
    ),
  );

/**
 * Firebase's v1 callable passes the Express request as `rawRequest`.
 * IP and UA extraction is intentionally defensive — we never want the
 * audit log write to blow up because a header was missing.
 */
function extractIp(req: unknown): string | null {
  if (!req || typeof req !== 'object') return null;
  const maybe = req as { ip?: unknown; headers?: Record<string, unknown> };
  if (typeof maybe.ip === 'string') return maybe.ip;
  const forwarded = maybe.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() || null;
  }
  return null;
}

function extractUserAgent(req: unknown): string | null {
  if (!req || typeof req !== 'object') return null;
  const headers = (req as { headers?: Record<string, unknown> }).headers;
  const ua = headers?.['user-agent'];
  return typeof ua === 'string' ? ua : null;
}
