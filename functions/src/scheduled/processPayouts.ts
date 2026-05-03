import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

export const processPayouts = functions.pubsub
  .schedule('0 2 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    functions.logger.info('Processing daily payouts...');

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const periodStart = new Date(yesterday);
    periodStart.setHours(0, 0, 0, 0);

    const periodEnd = new Date(yesterday);
    periodEnd.setHours(23, 59, 59, 999);

    // Get confirmed bookings from yesterday
    const bookingsSnapshot = await db
      .collection('bookings')
      .where('bookingStatus', '==', 'completed')
      .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(periodStart))
      .where('updatedAt', '<=', admin.firestore.Timestamp.fromDate(periodEnd))
      .get();

    // Group by spa
    const spaPayouts: Map<string, { bookings: string[]; total: number }> = new Map();

    for (const doc of bookingsSnapshot.docs) {
      const booking = doc.data();
      const spaId = booking.spaId;
      const spaAmount = (booking.pricing?.total || 0) - (booking.pricing?.platformFee || 0);

      if (spaPayouts.has(spaId)) {
        const existing = spaPayouts.get(spaId)!;
        existing.bookings.push(doc.id);
        existing.total += spaAmount;
      } else {
        spaPayouts.set(spaId, { bookings: [doc.id], total: spaAmount });
      }
    }

    // Create payout records
    const batch = db.batch();

    for (const [spaId, data] of spaPayouts.entries()) {
      const payoutRef = db.collection('payouts').doc();

      batch.set(payoutRef, {
        spaId,
        userId: (await db.collection('spas').doc(spaId).get()).data()?.ownerId,
        amount: {
          total: data.total,
          currency: 'INR',
        },
        bookingIds: data.bookings,
        period: {
          start: admin.firestore.Timestamp.fromDate(periodStart),
          end: admin.firestore.Timestamp.fromDate(periodEnd),
        },
        status: 'pending',
        paymentMethod: 'bank_transfer',
        processedAt: null,
        createdFrom: 'system',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    functions.logger.info('Daily payouts processing completed', { payoutRecordsCreated: spaPayouts.size, bookingsProcessed: bookingsSnapshot.size });
    return null;
  });
