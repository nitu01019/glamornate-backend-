import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

export const checkOutService = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'checkOutService', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const { bookingId, notes } = data;

  if (!bookingId) {
    throw new functions.https.HttpsError('invalid-argument', 'bookingId is required');
  }

  try {
    const bookingDoc = await db.collection('bookings').doc(bookingId).get();

    if (!bookingDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }

    const booking = bookingDoc.data()!;
    const userDoc = await db.collection('users').doc(context.auth.uid).get();
    const user = userDoc.data();

    // Only spa owner/staff can check out
    if (user?.spaData?.spaId !== booking.spaId && user?.role !== 'admin') {
      throw new functions.https.HttpsError('permission-denied', 'Only spa staff can check out a service');
    }

    if (!['en_route', 'in_service'].includes(booking.bookingStatus)) {
      throw new functions.https.HttpsError('failed-precondition', 'Booking is not in progress');
    }

    // Determine actor based on role
    const actor = user?.role === 'admin' ? 'admin' : 'spa';

    // Update booking
    await bookingDoc.ref.update({
      bookingStatus: 'completed',
      checkOut: {
        checkedOutAt: admin.firestore.FieldValue.serverTimestamp(),
        checkedOutBy: context.auth.uid,
        notes: notes || '',
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      'statusHistory': admin.firestore.FieldValue.arrayUnion({
        status: 'completed',
        from: booking.bookingStatus,
        to: 'completed',
        actor,
        actorId: context.auth.uid,
        timestamp: admin.firestore.Timestamp.now(),
        reason: 'Service completed',
      }),
    });

    // Trigger analytics update
    const bookingRevenue = booking.pricing?.total || 0;
    await updateSpaStatistics(booking.spaId, bookingRevenue);
    if (booking.therapistId) { await updateTherapistStatistics(booking.therapistId, bookingRevenue); }

    return { success: true };

  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);

async function updateSpaStatistics(spaId: string, revenue: number) {
  await db.collection('spas').doc(spaId).update({
    'statistics.totalBookings': admin.firestore.FieldValue.increment(1),
    'statistics.revenue': admin.firestore.FieldValue.increment(revenue),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function updateTherapistStatistics(therapistId: string, revenue: number) {
  await db.collection('therapists').doc(therapistId).update({
    'statistics.totalBookings': admin.firestore.FieldValue.increment(1),
    'statistics.revenue': admin.firestore.FieldValue.increment(revenue),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
