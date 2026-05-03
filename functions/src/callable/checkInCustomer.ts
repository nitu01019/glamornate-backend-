import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

export const checkInCustomer = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'checkInCustomer', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const { bookingId } = data;

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

    // Check if user is spa owner/staff or booking customer
    const isSpaStaff = user?.spaData?.spaId === booking.spaId;
    const isCustomer = booking.userId === context.auth.uid;

    if (!isSpaStaff && !isCustomer) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to check in this booking');
    }

    if (booking.bookingStatus !== 'confirmed') {
      throw new functions.https.HttpsError('failed-precondition', 'Booking is not confirmed');
    }

    // Update booking
    await bookingDoc.ref.update({
      bookingStatus: 'en_route',
      checkIn: {
        checkedInAt: admin.firestore.FieldValue.serverTimestamp(),
        checkedInBy: context.auth.uid,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      'statusHistory': admin.firestore.FieldValue.arrayUnion({
        status: 'en_route',
        from: 'confirmed',
        to: 'en_route',
        actor: isCustomer ? 'customer' : 'spa',
        actorId: context.auth.uid,
        timestamp: admin.firestore.Timestamp.now(),
        reason: 'Customer checked in',
      }),
    });

    return { success: true };

  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
