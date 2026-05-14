import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';
import { istDateAtTimeToUtc } from '../utils/date-ist';

const db = admin.firestore();
const logger = createLogger('rescheduleBooking');

// Narrow the Firestore booking-doc shape so the null-therapistId guard is
// type-checkable. `bookingDoc.data()!` returns `DocumentData` (effectively
// `any`); without this we'd be guarding an untyped field.
interface BookingDocData {
  userId: string;
  spaId: string;
  therapistId: string | null;
  bookingStatus: string;
  slot: { date: string; start: string; end: string; duration: number };
  updatedAt?: admin.firestore.Timestamp;
}

type SlotLite = {
  start: string;
  end: string;
  available?: boolean;
  bookingId?: string | null;
};

const RescheduleBookingSchema = z.object({
  bookingId: z.string(),
  newSlot: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    duration: z.number().positive(),
  }),
  reason: z.string().optional(),
});

type RescheduleBookingInput = z.infer<typeof RescheduleBookingSchema>;

export const rescheduleBooking = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'rescheduleBooking', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated: RescheduleBookingInput = RescheduleBookingSchema.parse(data);

    const bookingDoc = await db.collection('bookings').doc(validated.bookingId).get();

    if (!bookingDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }

    const booking = bookingDoc.data() as BookingDocData;
    const preTxnUpdatedAt = booking.updatedAt;

    if (booking.userId !== userId && booking.spaId !== (await db.collection('users').doc(userId).get()).data()?.spaData?.spaId) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to reschedule this booking');
    }

    // Phase 1 (Stripe removal, 2026-05-02) — `payment_pending` no longer
    // exists in the lifecycle; only confirmed bookings are reschedulable.
    if (booking.bookingStatus !== 'confirmed') {
      throw new functions.https.HttpsError('failed-precondition', 'Booking cannot be rescheduled');
    }

    const { date, start, end } = validated.newSlot;
    const oldSlot = booking.slot;

    // Use a transaction to atomically release old slot and hold new slot.
    // FIRESTORE RULE: All reads MUST occur before any writes within a transaction.
    //
    // Therapist-less bookings (booking.therapistId === null) skip the
    // availability hold/release entirely — the salon's ops side handles
    // conflicts manually for those, mirroring the createBooking.ts:52-74
    // optional-therapist pattern. A zero-availability-read transaction is
    // still valid Firestore (writes-only is permitted).
    await db.runTransaction(async (transaction) => {
      const bookingRef = db.collection('bookings').doc(validated.bookingId);

      // === FIRST READ (always): booking doc precondition check ===
      // Re-fetch the booking inside the transaction and assert its
      // updatedAt matches what the outer .get() saw. This closes the
      // L40-to-transaction-start race window where another reschedule
      // could have committed between the outer read and the txn start —
      // Firestore's own snapshot isolation only catches writes-during-
      // transaction, not writes-before-transaction.
      const bookingTxnSnap = await transaction.get(bookingRef);
      const txnBooking = bookingTxnSnap.data() as BookingDocData | undefined;
      if (!txnBooking) {
        throw new functions.https.HttpsError('not-found', 'Booking not found');
      }
      if (
        preTxnUpdatedAt &&
        txnBooking.updatedAt &&
        !preTxnUpdatedAt.isEqual(txnBooking.updatedAt)
      ) {
        throw new functions.https.HttpsError(
          'aborted',
          'Booking was modified by another session. Please refresh and try again.',
          { error: 'RESCHEDULE_CONFLICT' },
        );
      }

      // === CONDITIONAL: availability hold/release (only when a therapist is set) ===
      if (booking.therapistId) {
        const newAvailabilityRef = db
          .collection('availability')
          .doc(`${booking.spaId}_${date}_${booking.therapistId}`);
        const newAvailabilityDoc = await transaction.get(newAvailabilityRef);

        if (!newAvailabilityDoc.exists) {
          // Mirror createBooking.ts:69-72 — warn and proceed when the
          // availability cache hasn't been seeded for this (spa, date,
          // therapist) tuple. The booking doc is the source of truth;
          // availability is a cache/lock that can be backfilled by the
          // scheduled recalculateAvailability job.
          logger.warn('No availability doc found — skipping slot hold/release', {
            compositeId: `${booking.spaId}_${date}_${booking.therapistId}`,
            userId,
            bookingId: validated.bookingId,
          });
        } else {
          // Read availability for old slot (if different from new) — hoisted
          // up so it precedes all writes in the transaction.
          const slotChanged = oldSlot.date !== date || oldSlot.start !== start;
          const oldAvailabilityRef = slotChanged
            ? db
                .collection('availability')
                .doc(`${booking.spaId}_${oldSlot.date}_${booking.therapistId}`)
            : null;
          const oldAvailabilityDoc = oldAvailabilityRef
            ? await transaction.get(oldAvailabilityRef)
            : null;

          // === COMPUTE (still no writes) ===
          const newSlots: SlotLite[] = newAvailabilityDoc.data()?.slots || [];
          const newSlotIndex = newSlots.findIndex(
            (s) => s.start === start && s.end === end && s.available,
          );

          if (newSlotIndex === -1) {
            throw new functions.https.HttpsError(
              'aborted',
              'Selected time slot is no longer available',
              { error: 'SLOT_UNAVAILABLE' },
            );
          }

          // === WRITES AFTER ALL READS ===
          // Hold new slot — mutate the in-memory copy first so we can
          // decide whether the same-document case needs a single combined
          // write.
          newSlots[newSlotIndex] = {
            ...newSlots[newSlotIndex],
            available: false,
            bookingId: validated.bookingId,
          };

          // SAME-DOC CASE: when old + new slots live in the same
          // availability doc (same date + same therapist), two separate
          // transaction.update calls would have the second overwrite the
          // first because Firestore replaces the whole field value.
          // Apply BOTH mutations to the shared in-memory array, then
          // write once.
          const sameDoc =
            !!oldAvailabilityRef &&
            oldAvailabilityRef.path === newAvailabilityRef.path;

          if (sameDoc) {
            const oldSlotIndex = newSlots.findIndex(
              (s) =>
                s.start === oldSlot.start &&
                s.end === oldSlot.end &&
                s.bookingId === validated.bookingId,
            );
            if (oldSlotIndex !== -1) {
              newSlots[oldSlotIndex] = {
                ...newSlots[oldSlotIndex],
                available: true,
                bookingId: null,
              };
            }
            transaction.update(newAvailabilityRef, { slots: newSlots });
          } else {
            transaction.update(newAvailabilityRef, { slots: newSlots });

            if (
              oldAvailabilityRef &&
              oldAvailabilityDoc &&
              oldAvailabilityDoc.exists
            ) {
              const oldSlots: SlotLite[] =
                oldAvailabilityDoc.data()?.slots || [];
              const oldSlotIndex = oldSlots.findIndex(
                (s) =>
                  s.start === oldSlot.start &&
                  s.end === oldSlot.end &&
                  s.bookingId === validated.bookingId,
              );
              if (oldSlotIndex !== -1) {
                oldSlots[oldSlotIndex] = {
                  ...oldSlots[oldSlotIndex],
                  available: true,
                  bookingId: null,
                };
                transaction.update(oldAvailabilityRef, { slots: oldSlots });
              }
            }
          }
        }
      }

      // === ALWAYS: update the booking doc ===
      // Phase 2 (Booking Flow Fix v3.1, 2026-05-02): scheduledAt is the IST
      // wall-clock instant via istDateAtTimeToUtc — the legacy
      // `new Date(`${date}T${start}:00`)` interpreted the input as UTC.
      transaction.update(bookingRef, {
        slot: validated.newSlot,
        scheduledAt: admin.firestore.Timestamp.fromDate(istDateAtTimeToUtc(date, start)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        statusHistory: admin.firestore.FieldValue.arrayUnion({
          status: booking.bookingStatus,
          from: oldSlot,
          to: validated.newSlot,
          actor: booking.userId === userId ? 'customer' : 'spa',
          actorId: userId,
          timestamp: admin.firestore.Timestamp.now(),
          reason: validated.reason || 'Rescheduled',
        }),
      });
    });

    // S4: Audit log — record the slot change for compliance and to back
    // the UI "booking history" view. Contains both the previous and new
    // slot so disputes ("I never asked for Friday") are resolvable.
    try {
      await writeAuditLog({
        userId,
        action: 'booking.rescheduled',
        entity: { type: 'booking', id: validated.bookingId },
        before: { slot: oldSlot },
        after: { slot: validated.newSlot },
        metadata: {
          reason: validated.reason ?? null,
          actor: booking.userId === userId ? 'customer' : 'spa',
          spaId: booking.spaId,
          therapistId: booking.therapistId ?? null,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (rescheduleBooking)', auditError);
    }

    return {
      success: true,
      oldSlot,
      newSlot: validated.newSlot,
    };

  } catch (error: unknown) {
    throw handleError(error);
  }
    },
  ),
);
