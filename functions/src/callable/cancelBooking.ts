import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
// STRIPE_SECRET_KEY import removed (Phase 1 — Stripe removal, 2026-05-02).
// Refund-percentage block + pricing.platformFee cleanup are W1-B's scope.
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';

const logger = createLogger('cancelBooking');

const db = admin.firestore();

const CancelBookingSchema = z.object({
  bookingId: z.string(),
  reason: z.string().optional(),
});

type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

export const cancelBooking = callableOpts({
  maxInstances: 50,
}).https.onCall(
  withRateLimit(
    { name: 'cancelBooking', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated: CancelBookingInput = CancelBookingSchema.parse(data);

    const bookingDoc = await db.collection('bookings').doc(validated.bookingId).get();

    if (!bookingDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }

    const booking = bookingDoc.data()!;

    // Check permissions — single user doc read
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();
    const canCancel = booking.userId === userId ||
                      booking.spaId === userData?.spaData?.spaId ||
                      userData?.role === 'admin';

    if (!canCancel) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to cancel this booking');
    }

    if (booking.bookingStatus === 'cancelled' || booking.bookingStatus === 'completed') {
      throw new functions.https.HttpsError('failed-precondition', 'Booking cannot be cancelled');
    }

    // Phase 1 (Stripe removal, 2026-05-02) — refund-percentage policy and
    // total math removed. Pay-at-spa is the only payment mode, so there is
    // no captured online amount to refund. The cancellation policy is now
    // a spa-side concern (no-show fees, etc.) handled out-of-band.
    const { date, start, end } = booking.slot;
    const primaryCompositeId = `${booking.spaId}_${date}_${booking.therapistId}`;
    const fallbackCompositeId = `${booking.spaId}_${date}_any`;

    // Determine availability document reference (check both before transaction)
    let availabilityRef: FirebaseFirestore.DocumentReference | null = null;
    const primaryDoc = await db.collection('availability').doc(primaryCompositeId).get();
    if (primaryDoc.exists) {
      availabilityRef = primaryDoc.ref;
    } else if (booking.therapistId) {
      const fallbackDoc = await db.collection('availability').doc(fallbackCompositeId).get();
      if (fallbackDoc.exists) {
        availabilityRef = fallbackDoc.ref;
      }
    }

    // ATOMIC: Perform booking update AND slot release in a single transaction.
    // This prevents the race condition where booking is marked cancelled but the
    // slot stays blocked (making it unbook-able by other customers).
    // FIRESTORE RULE: All reads MUST occur before any writes within a transaction.
    await db.runTransaction(async (transaction) => {
      // === READS FIRST ===
      // Read availability doc up-front so we satisfy the read-before-write rule.
      const availabilityDoc = availabilityRef
        ? await transaction.get(availabilityRef)
        : null;

      // === WRITES AFTER ALL READS ===
      // Update booking status
      transaction.update(bookingDoc.ref, {
        bookingStatus: 'cancelled',
        cancellation: {
          reason: validated.reason || 'Cancelled by user',
          cancelledBy: userId,
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          // Pay-at-spa: no online amount captured → nothing to refund.
          refundedAmount: null,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        statusHistory: admin.firestore.FieldValue.arrayUnion({
          status: 'cancelled',
          from: booking.bookingStatus,
          to: 'cancelled',
          actor: booking.userId === userId ? 'customer' : 'spa',
          actorId: userId,
          timestamp: admin.firestore.Timestamp.now(),
          reason: validated.reason || 'Cancelled by user',
        }),
      });

      // Release availability slot atomically in the same transaction
      if (availabilityRef && availabilityDoc && availabilityDoc.exists) {
        const updatedSlots = (availabilityDoc.data()?.slots ?? []).map(
          (s: { start: string; end: string; bookingId?: string; available: boolean }) => {
            if (s.start === start && s.end === end && s.bookingId === validated.bookingId) {
              return { ...s, available: true, bookingId: null };
            }
            return s;
          }
        );
        transaction.update(availabilityRef, { slots: updatedSlots });
      }
    });

    // S4: Audit log — record the cancellation and who initiated it.
    // Written after the transaction commits so we only record the state
    // that actually landed. Failures are swallowed to avoid breaking the
    // user-facing return path. Refund math removed in Phase 1 (Stripe
    // removal, 2026-05-02) — pay-at-spa has no online amount to refund.
    try {
      await writeAuditLog({
        userId,
        action: 'booking.cancelled',
        entity: { type: 'booking', id: validated.bookingId },
        before: { status: booking.bookingStatus },
        after: { status: 'cancelled' },
        metadata: {
          reason: validated.reason ?? null,
          actor: booking.userId === userId ? 'customer' : 'spa',
          spaId: booking.spaId,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (cancelBooking)', auditError);
    }

    return {
      success: true,
      // Pay-at-spa: no online refund. Field retained as `null` for client
      // backward-compatibility (older APKs read this property).
      refundAmount: null,
      currency: booking.pricing?.currency ?? 'INR',
    };

  } catch (error: unknown) {
    throw handleError(error);
  }
    },
  ),
);
