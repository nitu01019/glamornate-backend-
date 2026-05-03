import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { todayIST } from '../utils/date-ist';

const db = admin.firestore();

interface BatchOp {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
}

interface GeneratedSlot {
  start: string;
  end: string;
  duration: number;
  available: boolean;
  bookingId: string | null;
}

export const recalculateAvailability = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async (context) => {
    functions.logger.info('Recalculating availability...');

    const now = new Date();
    const todayStr = todayIST();
    // Parse todayStr back to a Date for date arithmetic (in IST midnight terms)
    const today = new Date(`${todayStr}T00:00:00+05:30`);

    // Compute the 14-day window [todayStr, lastDateStr] inclusive — used to
    // narrow the per-spa bookings prefetch window in memory.
    const windowDays = 14;
    const lastDate = new Date(today);
    lastDate.setDate(lastDate.getDate() + windowDays - 1);
    const lastDateStr = lastDate.toISOString().split('T')[0];

    // Get active spas (cap result set to a hard ceiling to avoid runaway scans).
    const spasSnapshot = await db
      .collection('spas')
      .where('isActive', '==', true)
      .where('status', '==', 'active')
      .limit(2_000)
      .get();

    const batchOps: BatchOp[] = [];

    // Outer loop: per spa. Hoist the bookings prefetch + therapists query so
    // they are issued ONCE per spa rather than once per (spa, day). This turns
    // an N×D read pattern (e.g. 100 spas × 14 days = 1400 reads) into N reads.
    for (const spaDoc of spasSnapshot.docs) {
      const spa = spaDoc.data();
      const spaId = spaDoc.id;

      // Get all therapists for this spa (independent of day — hoist out).
      const therapistsSnapshot = await db
        .collection('therapists')
        .where('spaId', '==', spaId)
        .where('isActive', '==', true)
        .where('status', '==', 'online')
        .get();

      // Prefetch ALL active bookings for this spa once. We narrow the result
      // set in-memory to the 14-day window. The (spaId, bookingStatus) index
      // already exists, so no new composite index is required.
      // NOTE (Phase 1 — Stripe removal, 2026-05-02): 'payment_pending' dropped
      // from the status filter; pay-at-spa bookings go straight to 'confirmed'.
      const bookingsSnapshot = await db
        .collection('bookings')
        .where('spaId', '==', spaId)
        .where('bookingStatus', '==', 'confirmed')
        .get();

      // Group bookings by slot.date (string YYYY-MM-DD), filtered to the window.
      const bookingsByDate = new Map<string, FirebaseFirestore.DocumentData[]>();
      for (const bookingDoc of bookingsSnapshot.docs) {
        const booking = bookingDoc.data();
        const dateKey: string | undefined = booking?.slot?.date;
        if (typeof dateKey !== 'string') {
          continue;
        }
        // Restrict to the [todayStr, lastDateStr] window. String compare is
        // safe for ISO YYYY-MM-DD format.
        if (dateKey < todayStr || dateKey > lastDateStr) {
          continue;
        }
        const arr = bookingsByDate.get(dateKey);
        if (arr) {
          arr.push(booking);
        } else {
          bookingsByDate.set(dateKey, [booking]);
        }
      }

      // Inner loop: per day of the 14-day window. Same write outputs as before.
      for (let dayOffset = 0; dayOffset < windowDays; dayOffset++) {
        const date = new Date(today);
        date.setDate(date.getDate() + dayOffset);
        const dateStr = date.toISOString().split('T')[0];
        const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();

        // Check if spa is open on this day
        if (!spa.operatingHours?.[dayOfWeek]?.isOpen) {
          continue;
        }

        const { open: openStr, close: closeStr } = spa.operatingHours[dayOfWeek];

        // Read pre-grouped bookings for this date (no Firestore read here).
        const bookings = bookingsByDate.get(dateStr) ?? [];

        // Generate slots for "any therapist"
        const anyTherapistSlots = generateSlots(
          dateStr,
          openStr,
          closeStr,
          null,
          bookings
        );

        const compositeIdAny = `${spaId}_${dateStr}_any`;
        const availabilityDocAny = db.collection('availability').doc(compositeIdAny);

        batchOps.push({
          ref: availabilityDocAny,
          data: {
            compositeId: compositeIdAny,
            date: dateStr,
            spaId,
            therapistId: null,
            slots: anyTherapistSlots,
            lastCalculatedAt: admin.firestore.Timestamp.now(),
            expiresAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 5 * 60 * 1000)),
          },
        });

        // Generate slots for each therapist
        for (const therapistDoc of therapistsSnapshot.docs) {
          const therapist = therapistDoc.data();
          const therapistId = therapistDoc.id;

          // Check if therapist is on leave
          if (therapist.onLeave) {
            const leaveFrom = therapist.onLeaveFrom?.toDate();
            const leaveTo = therapist.onLeaveTo?.toDate();
            if (leaveFrom && leaveTo && date >= leaveFrom && date <= leaveTo) {
              continue;
            }
          }

          // Get therapist's custom availability for this day
          let therapistOpen = openStr;
          let therapistClose = closeStr;

          if (therapist.availability?.[dayOfWeek]) {
            const therapistDay = therapist.availability[dayOfWeek];
            if (therapistDay.length === 0) {
              // Therapist not working
              continue;
            }
            therapistOpen = therapistDay[0]?.start || openStr;
            therapistClose = therapistDay[therapistDay.length - 1]?.end || closeStr;
          }

          const slots = generateSlots(
            dateStr,
            therapistOpen,
            therapistClose,
            therapistId,
            bookings
          );

          const compositeId = `${spaId}_${dateStr}_${therapistId}`;
          const availabilityDoc = db.collection('availability').doc(compositeId);

          batchOps.push({
            ref: availabilityDoc,
            data: {
              compositeId,
              date: dateStr,
              spaId,
              therapistId,
              slots,
              lastCalculatedAt: admin.firestore.Timestamp.now(),
              expiresAt: admin.firestore.Timestamp.fromDate(new Date(now.getTime() + 5 * 60 * 1000)),
            },
          });
        }
      }
    }

    // Execute batch (max 500 operations per batch)
    for (let i = 0; i < batchOps.length; i += 500) {
      const batch = db.batch();
      const end = Math.min(i + 500, batchOps.length);
      for (let j = i; j < end; j++) {
        const op = batchOps[j];
        batch.set(op.ref, op.data, { merge: true });
      }
      await batch.commit();
    }

    functions.logger.info('Availability recalculation completed', { documentsProcessed: batchOps.length });
    return null;
  });

function generateSlots(
  dateStr: string,
  openStr: string,
  closeStr: string,
  therapistId: string | null,
  bookings: FirebaseFirestore.DocumentData[]
): GeneratedSlot[] {
  const [openHour, openMin] = openStr.split(':').map(Number);
  const [closeHour, closeMin] = closeStr.split(':').map(Number);

  const slots: GeneratedSlot[] = [];
  const slotDuration = 30; // 30-minute slots

  let currentHours = openHour;
  let currentMinutes = openMin;

  // Format time as HH:MM
  const formatTime = (h: number, m: number) => {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  while (currentHours < closeHour || (currentHours === closeHour && currentMinutes < closeMin)) {
    const start = formatTime(currentHours, currentMinutes);

    // Calculate end time
    let endMin = currentMinutes + slotDuration;
    let endHour = currentHours;

    if (endMin >= 60) {
      endHour += 1;
      endMin -= 60;
    }

    // Check if past closing time
    if (endHour > closeHour || (endHour === closeHour && endMin > closeMin)) {
      break;
    }

    const end = formatTime(endHour, endMin);

    // Check if this slot is already booked (using pre-fetched bookings)
    const slotStart = new Date(`${dateStr}T${start}:00`);
    const slotEnd = new Date(`${dateStr}T${end}:00`);

    const isBooked = bookings.some(booking => {
      const bookingStart = new Date(`${booking.slot.date}T${booking.slot.start}:00`);
      const bookingEnd = new Date(`${booking.slot.date}T${booking.slot.end}:00`);
      const therapistMatches = therapistId === null || booking.therapistId === therapistId;

      return therapistMatches &&
        slotStart < bookingEnd &&
        slotEnd > bookingStart;
    });

    slots.push({
      start,
      end,
      duration: slotDuration,
      available: !isBooked,
      bookingId: null,
    });

    currentMinutes = endMin;
    currentHours = endHour;
  }

  return slots;
}
