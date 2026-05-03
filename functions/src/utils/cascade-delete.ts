import * as admin from 'firebase-admin';
import { createLogger } from './logger';

const logger = createLogger('cascade-delete');

/**
 * Firestore's hard limit on the number of operations in a single batched
 * write is 500. We pick a slightly smaller chunk so we have headroom for
 * the journal-update write that happens on the same tick.
 */
export const BATCH_SIZE = 450;

/**
 * How long the deletion journal entry is retained. After this many days
 * a scheduled sweeper can purge completed jobs. Failed jobs stay until
 * an operator inspects them.
 */
export const JOB_JOURNAL_TTL_DAYS = 30;

/**
 * Ordered list of steps the cascade runs through. The order matters:
 *
 *   1. Subcollections / cross-collection docs scoped by userId are deleted
 *      BEFORE the owning `users/{uid}` doc so Firestore rules that read
 *      `users/{uid}` to resolve ownership still work during the scan.
 *   2. The user doc itself is deleted AFTER all scoped data is gone.
 *   3. Storage objects under `users/{uid}/**` and `temp/{uid}/**` are
 *      deleted AFTER Firestore is clean so any listener reacting to the
 *      user-doc deletion does not re-upload.
 *   4. The Firebase Auth record is deleted LAST — once it is gone the
 *      uid can never re-authenticate, so everything else must already
 *      be purged.
 *
 * Each step is recorded in the journal as it completes. On retry we
 * skip every completed step.
 */
export const CASCADE_STEPS = [
  'notifications',
  'bookings',
  'reviews',
  'user_vouchers',
  'wallets',
  'favorites',
  // Phase 4 / 4A: subcollection + migration journal sweep — runs
  // BEFORE `user_doc` so the parent document is still present while
  // we delete its children (subcollections in Firestore require a
  // client-side scan and don't auto-delete with the parent).
  'addresses',
  'address_migration',
  'user_doc',
  'storage_users',
  'storage_temp',
  'auth',
] as const;

export type CascadeStep = (typeof CASCADE_STEPS)[number];

export interface DeletionJobState {
  uid: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  completedSteps: CascadeStep[];
  counts: Partial<Record<CascadeStep, number>>;
  errors: Array<{ step: CascadeStep; message: string; at: string }>;
  startedAt?: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  retentionUntil: string;
}

export interface CascadeResult {
  /** true if this invocation did any actual work; false if it was a no-op resume. */
  performedWork: boolean;
  /** true when the function has nothing left to do (auth record is gone). */
  completed: boolean;
  /** Per-step counts. Zero is a valid result (e.g. user had no bookings). */
  counts: Partial<Record<CascadeStep, number>>;
  /** Non-fatal storage warnings captured via Promise.allSettled. */
  warnings: string[];
}

export interface CascadeDeps {
  db: FirebaseFirestore.Firestore;
  auth: admin.auth.Auth;
  bucket: ReturnType<admin.storage.Storage['bucket']>;
}

/**
 * Produce the default production dependencies. Tests can build their
 * own injection object and bypass this helper.
 */
export function defaultCascadeDeps(): CascadeDeps {
  return {
    db: admin.firestore(),
    auth: admin.auth(),
    bucket: admin.storage().bucket(),
  };
}

function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

/**
 * Read or initialise the deletion-journal row at `deletion_jobs/{uid}`.
 *
 * The journal is what makes the cascade idempotent: if the client
 * retries, we look up which steps have already been recorded as
 * completed and skip straight to the next one.
 */
async function loadOrCreateJournal(
  db: FirebaseFirestore.Firestore,
  uid: string
): Promise<{ ref: FirebaseFirestore.DocumentReference; state: DeletionJobState; alreadyCompleted: boolean }> {
  const ref = db.collection('deletion_jobs').doc(uid);
  const snap = await ref.get();

  if (snap.exists) {
    const data = snap.data() as DeletionJobState | undefined;
    if (data && data.status === 'completed') {
      return { ref, state: data, alreadyCompleted: true };
    }
    const state: DeletionJobState = {
      uid,
      status: data?.status ?? 'in_progress',
      completedSteps: data?.completedSteps ?? [],
      counts: data?.counts ?? {},
      errors: data?.errors ?? [],
      startedAt: data?.startedAt ?? admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      retentionUntil: data?.retentionUntil ?? isoDaysFromNow(JOB_JOURNAL_TTL_DAYS),
    };
    await ref.set(
      { ...state, status: 'in_progress', updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { ref, state, alreadyCompleted: false };
  }

  const state: DeletionJobState = {
    uid,
    status: 'in_progress',
    completedSteps: [],
    counts: {},
    errors: [],
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    retentionUntil: isoDaysFromNow(JOB_JOURNAL_TTL_DAYS),
  };
  await ref.set(state);
  return { ref, state, alreadyCompleted: false };
}

/**
 * Mark a step as completed in the journal. Atomic (arrayUnion) so two
 * concurrent retries cannot double-record the same step.
 */
async function markStepCompleted(
  ref: FirebaseFirestore.DocumentReference,
  step: CascadeStep,
  count: number
): Promise<void> {
  await ref.update({
    completedSteps: admin.firestore.FieldValue.arrayUnion(step),
    [`counts.${step}`]: count,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function markStepFailed(
  ref: FirebaseFirestore.DocumentReference,
  step: CascadeStep,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await ref.update({
    errors: admin.firestore.FieldValue.arrayUnion({
      step,
      message,
      at: new Date().toISOString(),
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Delete every doc returned by a collection query in batches of `BATCH_SIZE`.
 * Returns the total number of docs removed.
 */
async function deleteByQuery(
  db: FirebaseFirestore.Firestore,
  query: FirebaseFirestore.Query
): Promise<number> {
  let total = 0;
  // We cap the page size at BATCH_SIZE so each batch write stays under the
  // Firestore 500-op limit. We loop until the query returns no more docs.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(BATCH_SIZE).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < BATCH_SIZE) break;
  }
  return total;
}

/**
 * Recursively delete every document in a subcollection. Subcollections
 * cannot be deleted atomically — Firestore requires a client-side scan.
 */
async function deleteSubcollection(
  db: FirebaseFirestore.Firestore,
  collectionPath: string
): Promise<number> {
  return deleteByQuery(db, db.collection(collectionPath));
}

/**
 * Internal: run a single cascade step and record the result.
 */
async function runStep(
  step: CascadeStep,
  ref: FirebaseFirestore.DocumentReference,
  state: DeletionJobState,
  fn: () => Promise<number>
): Promise<{ skipped: boolean; count: number }> {
  if (state.completedSteps.includes(step)) {
    logger.info('Cascade step already completed — skipping', { step, uid: state.uid });
    return { skipped: true, count: state.counts[step] ?? 0 };
  }
  try {
    const count = await fn();
    await markStepCompleted(ref, step, count);
    logger.info('Cascade step complete', { step, uid: state.uid, count });
    return { skipped: false, count };
  } catch (error) {
    await markStepFailed(ref, step, error);
    logger.error(`Cascade step failed: ${step}`, error);
    throw error;
  }
}

/**
 * Orchestrates the full cascade for a single uid.
 *
 * The function is idempotent: calling it twice produces the same end
 * state. The second call finds the journal already marked `completed`
 * and returns immediately.
 */
export async function cascadeDeleteUserData(
  uid: string,
  depsInput?: Partial<CascadeDeps>
): Promise<CascadeResult> {
  const deps: CascadeDeps = { ...defaultCascadeDeps(), ...depsInput };
  const { db, auth, bucket } = deps;

  const { ref, state, alreadyCompleted } = await loadOrCreateJournal(db, uid);

  if (alreadyCompleted) {
    return {
      performedWork: false,
      completed: true,
      counts: state.counts,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const counts: Partial<Record<CascadeStep, number>> = { ...state.counts };

  // -----------------------------------------------------------------------
  // Firestore cross-collection deletes (scoped by userId == uid)
  // -----------------------------------------------------------------------
  counts.notifications = (
    await runStep('notifications', ref, state, () =>
      deleteByQuery(db, db.collection('notifications').where('userId', '==', uid))
    )
  ).count;

  counts.bookings = (
    await runStep('bookings', ref, state, () =>
      deleteByQuery(db, db.collection('bookings').where('userId', '==', uid))
    )
  ).count;

  counts.reviews = (
    await runStep('reviews', ref, state, () =>
      deleteByQuery(db, db.collection('reviews').where('userId', '==', uid))
    )
  ).count;

  counts.user_vouchers = (
    await runStep('user_vouchers', ref, state, () =>
      deleteByQuery(db, db.collection('user_vouchers').where('userId', '==', uid))
    )
  ).count;

  // -----------------------------------------------------------------------
  // Single-doc deletes keyed by uid
  // -----------------------------------------------------------------------
  counts.wallets = (
    await runStep('wallets', ref, state, async () => {
      const walletRef = db.collection('wallets').doc(uid);
      const snap = await walletRef.get();
      if (!snap.exists) return 0;
      await walletRef.delete();
      return 1;
    })
  ).count;

  // -----------------------------------------------------------------------
  // Subcollections
  // -----------------------------------------------------------------------
  counts.favorites = (
    await runStep('favorites', ref, state, () =>
      deleteSubcollection(db, `users/${uid}/favorites`)
    )
  ).count;

  // Phase 4 / 4A: address subcollection (added by 4A — must run BEFORE
  // `user_doc` since the parent doc still needs to exist while we
  // scan its children).
  counts.addresses = (
    await runStep('addresses', ref, state, () =>
      deleteSubcollection(db, `users/${uid}/addresses`)
    )
  ).count;

  // Phase 4 / 4A: address migration journal at `address_migrations/{uid}`.
  counts.address_migration = (
    await runStep('address_migration', ref, state, async () => {
      const migRef = db.collection('address_migrations').doc(uid);
      const snap = await migRef.get();
      if (!snap.exists) return 0;
      await migRef.delete();
      return 1;
    })
  ).count;

  // -----------------------------------------------------------------------
  // User doc (only after all data scoped by userId is gone)
  // -----------------------------------------------------------------------
  counts.user_doc = (
    await runStep('user_doc', ref, state, async () => {
      const userRef = db.collection('users').doc(uid);
      const snap = await userRef.get();
      if (!snap.exists) return 0;
      await userRef.delete();
      return 1;
    })
  ).count;

  // -----------------------------------------------------------------------
  // Storage
  // -----------------------------------------------------------------------
  counts.storage_users = (
    await runStep('storage_users', ref, state, async () => {
      try {
        const [files] = await bucket.getFiles({ prefix: `users/${uid}/` });
        if (files.length === 0) return 0;
        const results = await Promise.allSettled(files.map((f) => f.delete()));
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            const msg = `users/${uid}/* : ${files[i].name}: ${String(r.reason)}`;
            warnings.push(msg);
          }
        });
        return files.length;
      } catch (error) {
        // getFiles itself failed — rethrow so the journal marks the step failed.
        throw error;
      }
    })
  ).count;

  counts.storage_temp = (
    await runStep('storage_temp', ref, state, async () => {
      const [files] = await bucket.getFiles({ prefix: `temp/${uid}/` });
      if (files.length === 0) return 0;
      const results = await Promise.allSettled(files.map((f) => f.delete()));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          warnings.push(`temp/${uid}/* : ${files[i].name}: ${String(r.reason)}`);
        }
      });
      return files.length;
    })
  ).count;

  // -----------------------------------------------------------------------
  // Firebase Auth (last — once gone, the uid cannot re-authenticate)
  // -----------------------------------------------------------------------
  counts.auth = (
    await runStep('auth', ref, state, async () => {
      try {
        await auth.revokeRefreshTokens(uid);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code !== 'auth/user-not-found') throw err;
      }
      try {
        await auth.deleteUser(uid);
        return 1;
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'auth/user-not-found') return 0;
        throw err;
      }
    })
  ).count;

  // -----------------------------------------------------------------------
  // Finalise journal
  // -----------------------------------------------------------------------
  await ref.update({
    status: 'completed',
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    performedWork: true,
    completed: true,
    counts,
    warnings,
  };
}
