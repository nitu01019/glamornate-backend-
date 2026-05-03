import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { BOOKING_HOLD_DURATION_MS } from '../utils/constants';
import { todayIST } from '../utils/date-ist';

const db = admin.firestore();

/**
 * Auto-process booking transitions
 * Runs every 2 minutes to handle time-based state transitions
 */
export const autoProcessBookings = functions.pubsub
  .schedule('every 2 minutes')
  .onRun(async () => {
    functions.logger.info('Auto-processing bookings...');

    const now = new Date();
    const nowTimestamp = admin.firestore.Timestamp.fromDate(now);

    // 1. Cancel expired draft bookings (15 min timeout)
    //    NOTE (Phase 1 — Stripe removal, 2026-05-02): pay-at-spa bookings
    //    write directly to 'confirmed', so this branch is largely vestigial
    //    until a future cleanup. Left in place during the 14-day grace
    //    window in case any in-flight 'draft' rows pre-date the migration.
    await cancelExpiredDrafts(nowTimestamp);

    // (cancelExpiredPayments removed Phase 1 — no payment_pending state.)

    // 2. Auto-transition to en_route (5 min before)
    await autoTransitionToEnRoute(now);

    // 3. Auto-cancel no-shows (10 min after scheduled)
    await cancelNoShows(nowTimestamp);

    // 4. Release expired slot holds
    await releaseExpiredHolds(now);

    functions.logger.info('Auto-processing completed');

    return null;
  });

async function cancelExpiredDrafts(now: admin.firestore.Timestamp): Promise<number> {
  const cutoffTimestamp = admin.firestore.Timestamp.fromMillis(now.toMillis() - BOOKING_HOLD_DURATION_MS);

  const snapshot = await db.collection('bookings')
    .where('bookingStatus', '==', 'draft')
    .where('createdAt', '<=', cutoffTimestamp)
    .limit(100)
    .get();

  let cancelled = 0;

  for (const doc of snapshot.docs) {
    const booking = doc.data();

    // Update booking
    await doc.ref.update({
      bookingStatus: 'cancelled',
      cancellation: {
        reason: 'Booking expired due to inactivity',
        cancelledBy: 'system',
        cancelledAt: now,
        refundedAmount: 0,
      },
      updatedAt: now,
      'statusHistory': admin.firestore.FieldValue.arrayUnion({
        status: 'cancelled',
        from: 'draft',
        to: 'cancelled',
        actor: 'system',
        actorId: 'auto-process',
        timestamp: now,
        reason: 'Booking expired due to inactivity',
      }),
    });

    // Release slot
    await releaseSlot(booking);
    cancelled++;
  }

  if (cancelled > 0) {
    functions.logger.info(`Cancelled ${cancelled} expired draft bookings`);
  }

  return cancelled;
}

// cancelExpiredPayments removed (Phase 1 — Stripe removal, 2026-05-02).
// payment_pending is no longer a valid booking state; pay-at-spa flow writes
// 'confirmed' directly so there is no payment-window to expire.

async function autoTransitionToEnRoute(now: Date): Promise<number> {
  const lookaheadTimestamp = admin.firestore.Timestamp.fromMillis(now.getTime() + (5 * 60 * 1000));
  const fiveMinAgo = admin.firestore.Timestamp.fromMillis(now.getTime() - (5 * 60 * 1000));

  const snapshot = await db.collection('bookings')
    .where('bookingStatus', '==', 'confirmed')
    .where('scheduledAt', '<=', lookaheadTimestamp)
    .where('scheduledAt', '>=', fiveMinAgo)
    .limit(100)
    .get();

  let transitioned = 0;

  for (const doc of snapshot.docs) {
    const booking = doc.data();

    // Only transition if not already checked in
    if (!booking.checkIn) {
      await doc.ref.update({
        bookingStatus: 'en_route',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        'statusHistory': admin.firestore.FieldValue.arrayUnion({
          status: 'en_route',
          from: 'confirmed',
          to: 'en_route',
          actor: 'system',
          actorId: 'auto-process',
          timestamp: admin.firestore.Timestamp.now(),
          reason: 'Appointment time approaching',
        }),
      });

      // Send notification
      await db.collection('notifications').add({
        userId: booking.userId,
        type: 'en_route',
        title: 'Service Provider On The Way',
        body: 'Your service provider is on their way to the appointment',
        data: { bookingId: doc.id, type: 'en_route' },
        read: false,
        channels: { push: true, email: false, sms: false },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transitioned++;
    }
  }

  if (transitioned > 0) {
    functions.logger.info(`Transitioned ${transitioned} bookings to en_route`);
  }

  return transitioned;
}

async function cancelNoShows(now: admin.firestore.Timestamp): Promise<number> {
  const tenMinAgo = admin.firestore.Timestamp.fromMillis(now.toMillis() - (10 * 60 * 1000));

  const snapshot = await db.collection('bookings')
    .where('bookingStatus', 'in', ['confirmed', 'en_route'])
    .where('scheduledAt', '<=', tenMinAgo)
    .limit(100)
    .get();

  let cancelled = 0;

  for (const doc of snapshot.docs) {
    const booking = doc.data();

    // Only cancel if no check-in
    if (!booking.checkIn) {
      // Get pricing for fee
      const noShowFee = Math.round(booking.pricing?.total * 0.2); // 20% no-show fee

      await doc.ref.update({
        bookingStatus: 'cancelled',
        cancellation: {
          reason: 'No-show - customer did not check in',
          cancelledBy: 'system',
          cancelledAt: now,
          refundedAmount: Math.max(0, booking.pricing?.total - noShowFee || 0),
          isNoShow: true,
          noShowFee,
        },
        updatedAt: now,
        'statusHistory': admin.firestore.FieldValue.arrayUnion({
          status: 'cancelled',
          from: booking.bookingStatus,
          to: 'cancelled',
          actor: 'system',
          actorId: 'auto-process',
          timestamp: now,
          reason: 'No-show - customer did not check in',
        }),
      });

      // Deduct fee from wallet if possible
      await deductNoShowFee(booking.userId, noShowFee, doc.id);

      // Send notification
      await db.collection('notifications').add({
        userId: booking.userId,
        type: 'no_show',
        title: 'Booking Cancelled - No-Show',
        body: `Your booking was cancelled as you did not check in. A no-show fee of ₹${noShowFee} has been applied.`,
        data: { bookingId: doc.id, noShowFee, type: 'no_show' },
        read: false,
        channels: { push: true, email: true, sms: false },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      cancelled++;
    }
  }

  if (cancelled > 0) {
    functions.logger.info(`Cancelled ${cancelled} no-show bookings`);
  }

  return cancelled;
}

async function releaseExpiredHolds(now: Date): Promise<number> {
  const cutoffNow = admin.firestore.Timestamp.fromDate(now);
  const date = todayIST();

  // Get all availability documents for today
  const availabilitySnapshot = await db.collection('availability')
    .where('date', '>=', date)
    .where('expiresAt', '<=', cutoffNow)
    .limit(50)
    .get();

  let released = 0;

  for (const doc of availabilitySnapshot.docs) {
    const availability = doc.data();
    const slots = availability.slots || [];
    let updated = false;

    for (const slot of slots) {
      if (slot.heldUntil) {
        const heldUntil = slot.heldUntil.toDate();
        if (heldUntil < now) {
          slot.available = true;
          slot.bookingId = undefined;
          slot.heldUntil = undefined;
          updated = true;
          released++;
        }
      }
    }

    if (updated) {
      await doc.ref.update({
        slots,
        lastCalculatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  if (released > 0) {
    functions.logger.info(`Released ${released} expired slot holds`);
  }

  return released;
}

interface AvailabilitySlotLite {
  start: string;
  end: string;
  bookingId?: string | null;
  available?: boolean;
  heldUntil?: admin.firestore.Timestamp | null;
}

async function releaseSlot(booking: FirebaseFirestore.DocumentData): Promise<void> {
  const { date, start, end } = booking.slot as { date: string; start: string; end: string };
  const compositeId = `${booking.spaId}_${date}_${booking.therapistId}`;

  const doc = await db.collection('availability').doc(compositeId).get();
  if (!doc.exists) return;

  const availability = doc.data();
  if (!availability) return;
  const slots: AvailabilitySlotLite[] = availability.slots || [];

  const updatedSlots = slots.map((s) => {
    if (s.start === start && s.end === end && s.bookingId === booking.id) {
      return { ...s, available: true, bookingId: undefined, heldUntil: undefined };
    }
    return s;
  });

  await doc.ref.update({ slots: updatedSlots });
}

async function deductNoShowFee(userId: string, fee: number, bookingId: string): Promise<void> {
  if (fee <= 0) return;

  const walletRef = db.collection('wallets').doc(userId);
  const idempotencyTxnId = `txn_noShow_${bookingId}`;

  try {
    await db.runTransaction(async (txn) => {
      const walletDoc = await txn.get(walletRef);
      if (!walletDoc.exists) return;

      const wallet = walletDoc.data();
      if (!wallet) return;

      // Idempotency check: skip if this booking's fee was already deducted
      const alreadyCharged = (wallet.transactions || []).some(
        (t: { id: string }) => t.id === idempotencyTxnId
      );
      if (alreadyCharged) {
        functions.logger.info('No-show fee already deducted, skipping', { userId, bookingId });
        return;
      }

      if (wallet.balance?.current < fee) return;

      txn.update(walletRef, {
        'balance.current': admin.firestore.FieldValue.increment(-fee),
        'balance.debited': admin.firestore.FieldValue.increment(fee),
        transactions: admin.firestore.FieldValue.arrayUnion({
          id: idempotencyTxnId,
          type: 'debit' as const,
          amount: fee,
          description: 'No-show fee',
          reference: bookingId,
          createdAt: admin.firestore.Timestamp.now(),
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    functions.logger.info(`Deducted no-show fee`, { userId, fee, bookingId });
  } catch (err: unknown) {
    functions.logger.error('Failed to deduct no-show fee', { userId, fee, bookingId, err });
  }
}
