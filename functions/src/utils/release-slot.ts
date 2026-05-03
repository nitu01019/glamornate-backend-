/**
 * P2-01 — Shared slot-release helper (transaction-safe, idempotent,
 * read-before-write, ownership-safe).
 *
 * Every slot-release path in the system (cancelBooking, Stripe refund webhook,
 * onBookingStatusChanged, confirmBooking cleanup, safety-net sweeper) MUST
 * funnel through this helper so that lock/active-slot teardown is identical
 * across paths.
 *
 * Invariants enforced here:
 *
 *   1. READ phase precedes WRITE phase — Firestore forbids read-after-write
 *      inside a transaction.
 *   2. Ownership — we NEVER delete a slotLock unless its `bookingId` matches
 *      the booking we were asked to release.
 *   3. Idempotency — calling `releaseSlot` a second time for the same booking
 *      is a pure no-op (returns `released: false`).
 *   4. Active-slot cleanup — the `users/{uid}/_activeSlots/{date}` overlap
 *      guard is kept in sync by removing the exact `{ start, end, bookingId }`
 *      entry. Absence is treated as "already cleaned up" rather than an error.
 */

import * as admin from 'firebase-admin';

export interface ReleaseSlotParams {
  spaId: string;
  date: string;
  therapistId: string | null | undefined;
  start: string;
  /** Optional — kept on the API surface for callers that pass full slot
   *  metadata; not used in lock-id construction. */
  end?: string;
  bookingId: string;
  userId: string;
}

export interface ReleaseSlotResult {
  released: boolean;
  reasons: string[];
}

interface ActiveSlotEntry {
  start: string;
  end: string;
  bookingId: string;
  [k: string]: unknown;
}

/**
 * Known result reasons. Exported so call sites and tests can import the set
 * rather than string-compare literals.
 */
export const RELEASE_SLOT_REASONS = {
  LOCK_DELETED: 'lock_deleted',
  LOCK_OWNED_BY_OTHER_BOOKING: 'lock_owned_by_other_booking',
  NO_LOCK: 'no_lock',
  ACTIVE_SLOT_ENTRY_REMOVED: 'active_slot_entry_removed',
  NO_ACTIVE_SLOT_ENTRY: 'no_active_slot_entry',
  NO_ACTIVE_SLOTS_DOC: 'no_active_slots_doc',
} as const;

/** Build the composite id used for `slotLocks/{id}`. */
function buildSlotLockId(params: ReleaseSlotParams): string {
  const therapistKey = params.therapistId ?? 'any';
  return `${params.spaId}_${params.date}_${therapistKey}_${params.start}`;
}

/** Narrowing guard for active-slot entries coming back from Firestore. */
function isActiveSlotEntry(value: unknown): value is ActiveSlotEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.start === 'string' &&
    typeof e.end === 'string' &&
    typeof e.bookingId === 'string'
  );
}

/**
 * Release a previously-held slot lock and the matching per-user overlap
 * entry, atomically inside a caller-supplied transaction.
 */
export async function releaseSlot(
  txn: admin.firestore.Transaction,
  params: ReleaseSlotParams,
): Promise<ReleaseSlotResult> {
  const db = admin.firestore();
  const slotLockRef = db.collection('slotLocks').doc(buildSlotLockId(params));
  const activeSlotsRef = db
    .collection('users')
    .doc(params.userId)
    .collection('_activeSlots')
    .doc(params.date);

  // ----- READ PHASE -----
  const [slotLockSnap, activeSlotsSnap] = await Promise.all([
    txn.get(slotLockRef),
    txn.get(activeSlotsRef),
  ]);

  const reasons: string[] = [];
  let released = false;

  // ----- WRITE PHASE: slot lock -----
  if (slotLockSnap.exists) {
    const lockData = slotLockSnap.data() ?? {};
    const lockBookingId =
      typeof lockData.bookingId === 'string' ? lockData.bookingId : null;
    if (lockBookingId === params.bookingId) {
      txn.delete(slotLockRef);
      released = true;
      reasons.push(RELEASE_SLOT_REASONS.LOCK_DELETED);
    } else {
      reasons.push(RELEASE_SLOT_REASONS.LOCK_OWNED_BY_OTHER_BOOKING);
    }
  } else {
    reasons.push(RELEASE_SLOT_REASONS.NO_LOCK);
  }

  // ----- WRITE PHASE: per-user _activeSlots entry -----
  if (!activeSlotsSnap.exists) {
    reasons.push(RELEASE_SLOT_REASONS.NO_ACTIVE_SLOTS_DOC);
  } else {
    const data = activeSlotsSnap.data() as { slots?: unknown } | undefined;
    const rawSlots = data?.slots;
    const existingSlots: ActiveSlotEntry[] = Array.isArray(rawSlots)
      ? rawSlots.filter(isActiveSlotEntry)
      : [];
    const matchingIdx = existingSlots.findIndex(
      (s) => s.bookingId === params.bookingId,
    );
    if (matchingIdx === -1) {
      reasons.push(RELEASE_SLOT_REASONS.NO_ACTIVE_SLOT_ENTRY);
    } else {
      const nextSlots = existingSlots.filter(
        (s) => s.bookingId !== params.bookingId,
      );
      txn.set(activeSlotsRef, { slots: nextSlots }, { merge: true });
      released = true;
      reasons.push(RELEASE_SLOT_REASONS.ACTIVE_SLOT_ENTRY_REMOVED);
    }
  }

  return { released, reasons };
}
