import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

export const aggregateAnalytics = functions.pubsub
  .schedule('0 * * * *')
  .onRun(async (context) => {
    functions.logger.info('Aggregating hourly analytics...');

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const bookingSnapshot = await db
      .collection('bookings')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(hourAgo))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(now))
      .get();

    const analyticsMap: Map<string, any> = new Map();

    for (const doc of bookingSnapshot.docs) {
      const booking = doc.data();
      const key = booking.bookingStatus;

      if (!analyticsMap.has(key)) {
        analyticsMap.set(key, { count: 0, total: 0 });
      }

      const data = analyticsMap.get(key)!;
      data.count++;
      data.total += booking.pricing?.total || 0;
    }

    const compositeId = `bookings_hourly_${now.toISOString().slice(0, 13)}`;
    const analyticsRef = db.collection('analytics').doc(compositeId);

    await analyticsRef.set({
      compositeId,
      type: 'bookings',
      period: 'hourly',
      date: admin.firestore.Timestamp.fromDate(now),
      data: Object.fromEntries(analyticsMap),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    functions.logger.info('Hourly analytics aggregation completed', { bookingsProcessed: bookingSnapshot.size, compositeId });
    return null;
  });
