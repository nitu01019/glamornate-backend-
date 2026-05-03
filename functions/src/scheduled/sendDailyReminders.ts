import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { todayIST } from '../utils/date-ist';

const db = admin.firestore();

export const sendDailyReminders = functions.pubsub
  .schedule('0 8 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    functions.logger.info('Sending daily reminders...');

    const todayStr = todayIST();

    // Get confirmed bookings for today
    const bookingsSnapshot = await db
      .collection('bookings')
      .where('bookingStatus', '==', 'confirmed')
      .where('slot.date', '==', todayStr)
      .get();

    const batch = db.batch();
    const notificationMap: Map<string, any[]> = new Map();

    // Group bookings by user
    for (const doc of bookingsSnapshot.docs) {
      const booking = doc.data();
      const userId = booking.userId;

      if (!notificationMap.has(userId)) {
        notificationMap.set(userId, []);
      }

      notificationMap.get(userId)!.push({
        bookingId: doc.id,
        spaId: booking.spaId,
        time: booking.slot.start,
        serviceCount: booking.serviceIds.length,
      });
    }

    // Create notifications
    for (const [userId, bookings] of notificationMap.entries()) {
      const notificationRef = db.collection('notifications').doc();

      let message: string;
      if (bookings.length === 1) {
        const b = bookings[0];
        const spa = (await db.collection('spas').doc(b.spaId).get()).data();
        message = `Your session at ${spa?.name || 'the spa'} is scheduled for ${b.time} today.`;
      } else {
        message = `You have ${bookings.length} sessions scheduled for today.`;
      }

      batch.set(notificationRef, {
        userId,
        type: 'daily_reminder',
        title: 'Today\'s Appointments',
        body: message,
        data: { bookings, type: 'reminder' },
        read: false,
        channels: { push: true, email: true, sms: false },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    functions.logger.info('Daily reminders sent', { usersNotified: notificationMap.size, date: todayStr });
    return null;
  });
