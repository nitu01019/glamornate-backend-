import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';
import { USER_KEYED_COLLECTIONS } from '../shared/contracts/auth';

/**
 * mergeUserAccounts — admin-only callable.
 *
 * Phase 4 (Booking Flow Fix v3.1, 2026-05-02): the `linkWithCredential`
 * flow on the client recovers the case where the user has *not yet*
 * created data under the secondary uid. When they have — bookings, saved
 * addresses, notification preferences — we need a server-side sweep to
 * move that data onto the primary uid.
 *
 * Customer-self-serve was rejected by the security council: irreversible
 * + cross-tenant + handles PII. Operators invoke this from the support
 * tool after verifying the user owns both accounts (typical evidence:
 * matching phone + recent booking history).
 *
 * Soft-deletes the secondary user (sets isActive=false, role='_merged'
 * placeholder). Bookings, transactions (legacy), notifications, and
 * other user-keyed collections are reassigned to the primary uid via
 * batched writes; subcollections of the secondary (addresses, favorites)
 * are archived. Audit-log records both the before and after.
 *
 * ε3 hardening (echo-3, 2026-05-12):
 *
 *   α8-5 — TOCTOU mitigation. The admin role check is re-read inside a
 *          Firestore transaction at the start of EACH chunk + at the
 *          soft-delete step. If the caller is demoted mid-flight the
 *          remaining work aborts. Pillar 2 (session management).
 *
 *   α8-6 — isActive precondition. Refuse to merge a still-active
 *          secondary user. Operator must mark the secondary inactive
 *          (via support tools) first, which forces a deliberate "stop &
 *          confirm" step before any irreversible reassignment.
 *
 *   α8-7 — dynamic collection list. The list of user-keyed collections
 *          to sweep lives in `shared/contracts/auth.ts` so adding a new
 *          userId-keyed top-level collection auto-extends the merge
 *          sweep. Previously hardcoded to ['bookings','notifications'],
 *          silently orphaning wallet/reviews/etc.
 *
 *   α8-8 — `merge_jobs/{secondaryUid}` journal. Each phase boundary
 *          writes a journal entry so a mid-crash leaves a recoverable
 *          state. Re-invocation with the same secondaryUid is idempotent
 *          for completed jobs (no-op) and short-circuits in-flight jobs
 *          to prevent concurrent merges. Mirrors the deletion_jobs
 *          pattern in `auth/delete-account.ts`.
 */
const db = admin.firestore();
const logger = createLogger('mergeUserAccounts');

const MergeInputSchema = z.object({
  primaryUid: z.string().min(1),
  secondaryUid: z.string().min(1),
  reason: z.string().min(3).max(500),
});

type MergeInput = z.infer<typeof MergeInputSchema>;

/** Subcollections under `users/{secondaryUid}` that get archived rather than reassigned. */
const SUBCOLLECTIONS_OF_SECONDARY = ['addresses', 'favorites'] as const;

/**
 * In-flight grace window. Another invocation for the same secondaryUid
 * within this window is rejected; older `in_progress` entries are
 * treated as crashed and allowed to resume.
 */
const IN_FLIGHT_GRACE_MS = 5 * 60 * 1000;

/**
 * Firestore batch hard limit is 500 ops; we leave headroom for the
 * journal append in case a future revision groups them.
 */
const BATCH_CHUNK_SIZE = 400;

type MergeJobStatus = 'in_progress' | 'completed' | 'failed';

interface MergeJobRecord {
  status: MergeJobStatus;
  primaryUid: string;
  secondaryUid: string;
  reason: string;
  startedAt?: admin.firestore.Timestamp;
  startedAtMillis?: number;
  completedAt?: admin.firestore.Timestamp;
  failedAt?: admin.firestore.Timestamp;
  attemptedCollections?: string[];
  completedCollections?: string[];
  counters?: Record<string, number>;
  error?: string;
}

/**
 * Re-reads the caller's `users/{uid}.role` inside a transaction and
 * throws `permission-denied` if it isn't `'admin'`. Single source of
 * truth for the admin gate — used at the initial check AND repeated at
 * every destructive boundary to close the TOCTOU window (α8-5).
 */
async function assertAdminTx(
  tx: admin.firestore.Transaction,
  callerUid: string,
): Promise<void> {
  const snap = await tx.get(db.collection('users').doc(callerUid));
  if (!snap.exists || snap.data()?.role !== 'admin') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'mergeUserAccounts is admin-only.',
    );
  }
}

/** Convenience: read the merge_jobs journal entry for a given secondary uid. */
async function readJournal(
  secondaryUid: string,
): Promise<MergeJobRecord | null> {
  const snap = await db.collection('merge_jobs').doc(secondaryUid).get();
  return snap.exists ? (snap.data() as MergeJobRecord) : null;
}

export const mergeUserAccounts = callableOpts({ maxInstances: 5 }).https.onCall(
  withRateLimit(
    { name: 'mergeUserAccounts', windowMs: 60_000, max: 10 },
    async (data, context) => {
      if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
      }

      const callerUid = context.auth.uid;

      // ---------------------------------------------------------------
      // 1. Admin gate (initial check). The transactional re-check at
      //    each destructive boundary is what actually closes the TOCTOU
      //    window — this first read just lets us fail fast on the
      //    common case (non-admin) without paying for input validation.
      // ---------------------------------------------------------------
      const callerDoc = await db.collection('users').doc(callerUid).get();
      if (!callerDoc.exists || callerDoc.data()?.role !== 'admin') {
        throw new functions.https.HttpsError(
          'permission-denied',
          'mergeUserAccounts is admin-only.',
        );
      }

      // ---------------------------------------------------------------
      // 2. Validate payload
      // ---------------------------------------------------------------
      let validated: MergeInput;
      try {
        validated = MergeInputSchema.parse(data);
      } catch (err) {
        throw handleError(err);
      }

      if (validated.primaryUid === validated.secondaryUid) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'primaryUid and secondaryUid must differ.',
          { error: 'SAME_UID' },
        );
      }

      // ---------------------------------------------------------------
      // 3. Idempotency / journal pre-check (α8-8)
      // ---------------------------------------------------------------
      const existingJournal = await readJournal(validated.secondaryUid);
      if (existingJournal) {
        if (
          existingJournal.status === 'completed' &&
          existingJournal.primaryUid === validated.primaryUid
        ) {
          logger.info('mergeUserAccounts re-invoked for completed merge', {
            secondaryUid: validated.secondaryUid,
          });
          return {
            success: true,
            primaryUid: validated.primaryUid,
            secondaryUid: validated.secondaryUid,
            counters: existingJournal.counters ?? {},
            alreadyMerged: true,
          };
        }
        if (existingJournal.status === 'in_progress') {
          const startedMs = existingJournal.startedAtMillis ?? 0;
          if (Date.now() - startedMs < IN_FLIGHT_GRACE_MS) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'Merge already in flight for this secondary user.',
              { error: 'MERGE_IN_FLIGHT' },
            );
          }
          logger.warn('Resuming stale in_progress merge', {
            secondaryUid: validated.secondaryUid,
            startedMs,
          });
        }
        // status === 'failed' or stale 'in_progress' → fall through and resume
      }

      // ---------------------------------------------------------------
      // 4. Existence + isActive precondition (α8-6)
      // ---------------------------------------------------------------
      const [primarySnap, secondarySnap] = await Promise.all([
        db.collection('users').doc(validated.primaryUid).get(),
        db.collection('users').doc(validated.secondaryUid).get(),
      ]);

      if (!primarySnap.exists || !secondarySnap.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'One or both user documents do not exist.',
          { error: 'USER_NOT_FOUND' },
        );
      }

      // α8-6: refuse to merge an active secondary user. Operator must
      // mark it inactive via support tools first. Resumes of a
      // previously-started merge are exempt because the secondary will
      // already be `isActive: false` from that prior pass.
      const secondaryIsActive = secondarySnap.data()?.isActive !== false;
      const resuming = existingJournal?.status === 'in_progress' ||
        existingJournal?.status === 'failed';
      if (secondaryIsActive && !resuming) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Cannot merge an active user. Mark the secondary user inactive first (via support tools) before invoking merge.',
          { error: 'SECONDARY_USER_STILL_ACTIVE' },
        );
      }

      const collectionsToSweep = USER_KEYED_COLLECTIONS;
      const counters: Record<string, number> = {};
      const completedCollections: string[] = [];

      // ---------------------------------------------------------------
      // 5. Open the journal entry (α8-8)
      // ---------------------------------------------------------------
      const journalRef = db.collection('merge_jobs').doc(validated.secondaryUid);
      const startedAtMillis = Date.now();
      try {
        await journalRef.set({
          status: 'in_progress',
          primaryUid: validated.primaryUid,
          secondaryUid: validated.secondaryUid,
          reason: validated.reason,
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          startedAtMillis,
          attemptedCollections: collectionsToSweep,
          completedCollections: [],
        });
      } catch (journalError) {
        logger.error('merge_jobs journal open failed — aborting', journalError);
        throw new functions.https.HttpsError(
          'internal',
          'Merge journal write failed.',
          { error: 'JOURNAL_WRITE_FAILED' },
        );
      }

      try {
        // -------------------------------------------------------------
        // 6. Reassign every userId-keyed top-level collection (α8-7)
        // -------------------------------------------------------------
        for (const collection of collectionsToSweep) {
          const snapshot = await db
            .collection(collection)
            .where('userId', '==', validated.secondaryUid)
            .get();

          const docs = snapshot.docs;
          let written = 0;

          // α8-5: re-assert admin role at the start of each chunk via
          // a Firestore transaction. Each chunk is its own all-or-nothing
          // boundary. If the caller is demoted between chunks, the next
          // chunk's tx.get() observes the change and aborts the merge.
          for (let i = 0; i < docs.length; i += BATCH_CHUNK_SIZE) {
            const slice = docs.slice(i, i + BATCH_CHUNK_SIZE);
            await db.runTransaction(async (tx) => {
              await assertAdminTx(tx, callerUid);
              for (const doc of slice) {
                tx.update(doc.ref, {
                  userId: validated.primaryUid,
                  _mergedFrom: validated.secondaryUid,
                  _mergedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            });
            written += slice.length;
          }
          counters[collection] = written;
          completedCollections.push(collection);

          // Journal append after each collection completes.
          await journalRef.update({
            completedCollections,
            counters,
          });
        }

        // -------------------------------------------------------------
        // 7. Soft-delete the secondary user inside a transaction with
        //    a fresh admin re-check (α8-5). The doc itself stays so
        //    cross-references resolve; the `_merged` role removes it
        //    from every role-gated query.
        // -------------------------------------------------------------
        await db.runTransaction(async (tx) => {
          await assertAdminTx(tx, callerUid);
          tx.update(db.collection('users').doc(validated.secondaryUid), {
            isActive: false,
            role: '_merged',
            mergedInto: validated.primaryUid,
            mergedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        // -------------------------------------------------------------
        // 8. Archive secondary subcollections (addresses, favorites)
        // -------------------------------------------------------------
        for (const sub of SUBCOLLECTIONS_OF_SECONDARY) {
          const subSnap = await db
            .collection('users')
            .doc(validated.secondaryUid)
            .collection(sub)
            .get();
          let archived = 0;
          for (let i = 0; i < subSnap.docs.length; i += BATCH_CHUNK_SIZE) {
            const slice = subSnap.docs.slice(i, i + BATCH_CHUNK_SIZE);
            await db.runTransaction(async (tx) => {
              await assertAdminTx(tx, callerUid);
              for (const doc of slice) {
                tx.update(doc.ref, {
                  _archivedByMerge: validated.primaryUid,
                  _archivedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            });
            archived += slice.length;
          }
          const subKey = `users/${validated.secondaryUid}/${sub}`;
          counters[subKey] = archived;
          completedCollections.push(subKey);
        }

        // -------------------------------------------------------------
        // 9. Audit log
        // -------------------------------------------------------------
        try {
          await writeAuditLog({
            userId: callerUid,
            action: 'user.accounts.merged',
            entity: { type: 'user', id: validated.primaryUid },
            before: { secondaryUid: validated.secondaryUid },
            after: {
              primaryUid: validated.primaryUid,
              counters,
              reason: validated.reason,
            },
            metadata: { actor: 'admin' },
          });
        } catch (auditError) {
          logger.warn('writeAuditLog failed (mergeUserAccounts)', auditError);
        }

        // -------------------------------------------------------------
        // 10. Finalize journal (α8-8)
        // -------------------------------------------------------------
        await journalRef.update({
          status: 'completed',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          completedCollections,
          counters,
        });

        logger.info('Merged user accounts', {
          adminUid: callerUid,
          primaryUid: validated.primaryUid,
          secondaryUid: validated.secondaryUid,
          counters,
        });

        return {
          success: true,
          primaryUid: validated.primaryUid,
          secondaryUid: validated.secondaryUid,
          counters,
        };
      } catch (error: unknown) {
        logger.error('mergeUserAccounts failed', { error });
        // Journal failure outcome (α8-8) — best-effort, never mask the
        // real error.
        try {
          await journalRef.update({
            status: 'failed',
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            completedCollections,
            counters,
            error:
              error instanceof functions.https.HttpsError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : 'unknown',
          });
        } catch (journalErr) {
          logger.warn('merge_jobs journal failure-finalize failed', journalErr);
        }

        if (error instanceof functions.https.HttpsError) {
          throw error;
        }
        throw handleError(error);
      }
    },
  ),
);
