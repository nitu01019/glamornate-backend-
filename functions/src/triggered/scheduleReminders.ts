import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

/**
 * When a booking is confirmed, stamp reminder metadata onto the booking document.
 * Actual reminder delivery is handled by the sendDailyReminders scheduled function
 * which runs every morning at 08:00 IST and queries confirmed bookings for that day.
 *
 * Previously this function scheduled Cloud Tasks targeting a sendBookingReminder
 * HTTP endpoint that was never exported, causing 404s in production.
 * Replaced with a lightweight Firestore update that the existing cron consumes.
 */
export const scheduleReminders = functions.firestore
  .document('bookings/{bookingId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    // Only process when booking transitions to confirmed
    if (before.bookingStatus !== 'confirmed' && after.bookingStatus === 'confirmed') {
      const bookingRef = db.collection('bookings').doc(context.params.bookingId);

      await bookingRef.update({
        reminderSent: {
          '24hr': false,
          '2hr': false,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      functions.logger.info('Reminder metadata set for booking', {
        bookingId: context.params.bookingId,
      });
    }

    return null;
  });
