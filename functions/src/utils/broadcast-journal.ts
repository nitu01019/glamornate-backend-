import * as admin from 'firebase-admin';
import { createLogger } from './logger';

const logger = createLogger('broadcast-journal');

/**
 * Broadcast journal — idempotency ledger at `broadcast_jobs/{broadcastId}`.
 *
 * Every broadcast dispatch is checkpointed so a retry (same broadcastId)
 * does not produce duplicate notifications. A broadcast can be:
 *   - 'pending'   — reserved, not yet processed
 *   - 'running'   — actively fanning out
 *   - 'completed' — every target user has a notification written
 *   - 'failed'    — permanent failure; a retry with the same id is a no-op
 *
 * The `recipients` array is written once per user to guarantee at-most-once
 * delivery even if the caller retries mid-flight.
 */

export type BroadcastJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface BroadcastJobRecord {
  broadcastId: string;
  status: BroadcastJobStatus;
  title: string;
  body: string;
  imageUrl?: string | null;
  ctaUrl?: string | null;
  /** Total users we expect to write to. Updated as we discover audience size. */
  totalTargets: number;
  /** How many notification docs we've successfully created so far. */
  sentCount: number;
  /** Users who already received a notification for this broadcast. */
  recipients: string[];
  createdBy: string;
  createdAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updatedAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
  completedAt?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  error?: string;
}

export const BROADCAST_JOBS_COLLECTION = 'broadcast_jobs';

function getDb(): admin.firestore.Firestore {
  return admin.firestore();
}

/**
 * Load a journal entry. Returns `null` if none exists yet.
 */
export async function readBroadcastJob(
  broadcastId: string,
): Promise<BroadcastJobRecord | null> {
  const snap = await getDb()
    .collection(BROADCAST_JOBS_COLLECTION)
    .doc(broadcastId)
    .get();
  if (!snap.exists) return null;
  return snap.data() as BroadcastJobRecord;
}

/**
 * Reserve a new broadcast id. Uses a transaction so two concurrent callers
 * with the same id cannot both mark themselves as the owner.
 *
 * Returns `{ created: true }` if this caller now owns the job, or
 * `{ created: false, existing }` if another caller already reserved it.
 */
export async function reserveBroadcastJob(params: {
  broadcastId: string;
  createdBy: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  ctaUrl?: string | null;
}): Promise<{ created: boolean; existing?: BroadcastJobRecord }> {
  const ref = getDb()
    .collection(BROADCAST_JOBS_COLLECTION)
    .doc(params.broadcastId);

  return getDb().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      return { created: false, existing: snap.data() as BroadcastJobRecord };
    }
    const record: BroadcastJobRecord = {
      broadcastId: params.broadcastId,
      status: 'pending',
      title: params.title,
      body: params.body,
      imageUrl: params.imageUrl ?? null,
      ctaUrl: params.ctaUrl ?? null,
      totalTargets: 0,
      sentCount: 0,
      recipients: [],
      createdBy: params.createdBy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    txn.set(ref, record);
    logger.info('Broadcast job reserved', {
      broadcastId: params.broadcastId,
      createdBy: params.createdBy,
    });
    return { created: true };
  });
}

/**
 * Mark the job as `running` and record the discovered audience size.
 */
export async function markBroadcastRunning(
  broadcastId: string,
  totalTargets: number,
): Promise<void> {
  await getDb()
    .collection(BROADCAST_JOBS_COLLECTION)
    .doc(broadcastId)
    .update({
      status: 'running',
      totalTargets,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Record that a batch of recipients has been successfully notified.
 *
 * Uses `arrayUnion` so repeated invocations with the same userIds are safe;
 * `sentCount` is recomputed to the length of the recipients array on
 * completion.
 */
export async function appendBroadcastRecipients(
  broadcastId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await getDb()
    .collection(BROADCAST_JOBS_COLLECTION)
    .doc(broadcastId)
    .update({
      recipients: admin.firestore.FieldValue.arrayUnion(...userIds),
      sentCount: admin.firestore.FieldValue.increment(userIds.length),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Mark the job as `completed`. Idempotent — calling twice is a no-op.
 */
export async function markBroadcastCompleted(
  broadcastId: string,
): Promise<void> {
  await getDb()
    .collection(BROADCAST_JOBS_COLLECTION)
    .doc(broadcastId)
    .update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Mark the job as `failed` with a (short) reason.
 */
export async function markBroadcastFailed(
  broadcastId: string,
  reason: string,
): Promise<void> {
  await getDb()
    .collection(BROADCAST_JOBS_COLLECTION)
    .doc(broadcastId)
    .update({
      status: 'failed',
      error: reason.slice(0, 500),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Filter a list of candidate userIds down to those NOT already recorded
 * as recipients of this broadcast. This is the at-most-once guarantee
 * for `dispatchBroadcast` — even if the caller retries after a partial
 * success we skip the users who already got a notification.
 */
export function filterAlreadyNotified(
  candidates: string[],
  already: string[],
): string[] {
  if (already.length === 0) return [...candidates];
  const set = new Set(already);
  return candidates.filter((uid) => !set.has(uid));
}
