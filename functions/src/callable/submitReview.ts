import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { sanitizeInput } from '../utils/validator';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

const SubmitReviewSchema = z.object({
  bookingId: z.string(),
  rating: z.number().min(1).max(5),
  title: z.string().min(1).max(100),
  comment: z.string().min(10).max(1000),
  aspects: z.object({
    ambiance: z.number().min(1).max(5).optional(),
    service: z.number().min(1).max(5).optional(),
    therapist: z.number().min(1).max(5).optional(),
    hygiene: z.number().min(1).max(5).optional(),
  }).optional(),
  photos: z.array(z.string()).optional(),
});

type SubmitReviewInput = z.infer<typeof SubmitReviewSchema>;

export const submitReview = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'submitReview', windowMs: 60 * 60 * 1000, max: 3 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated: SubmitReviewInput = SubmitReviewSchema.parse(data);

    // Get booking
    const bookingDoc = await db.collection('bookings').doc(validated.bookingId).get();

    if (!bookingDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }

    const booking = bookingDoc.data()!;

    if (booking.userId !== userId) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to review this booking');
    }

    if (booking.bookingStatus !== 'completed') {
      throw new functions.https.HttpsError('failed-precondition', 'Can only review completed bookings');
    }

    if (booking.reviewId) {
      throw new functions.https.HttpsError('already-exists', 'Review already submitted');
    }

    // Check for existing review (same booking)
    const existingReview = await db
      .collection('reviews')
      .where('bookingId', '==', validated.bookingId)
      .where('userId', '==', userId)
      .get();

    if (!existingReview.empty) {
      throw new functions.https.HttpsError('already-exists', 'Review already exists for this booking');
    }

    // Create review
    const now = admin.firestore.Timestamp.now();
    const reviewData = {
      userId,
      bookingId: validated.bookingId,
      spaId: booking.spaId,
      therapistId: booking.therapistId,
      rating: validated.rating,
      aspects: validated.aspects || {
        ambiance: 0,
        service: 0,
        therapist: 0,
        hygiene: 0,
      },
      title: sanitizeInput(validated.title),
      comment: sanitizeInput(validated.comment),
      photos: validated.photos || [],
      helpfulCount: 0,
      reportedCount: 0,
      moderation: {
        status: 'pending' as const,
        moderatedBy: null,
      },
      reportedBy: [],
      createdAt: now,
      updatedAt: now,
    };

    const reviewRef = await db.collection('reviews').add(reviewData);

    // Update booking with review reference
    await bookingDoc.ref.update({
      reviewId: reviewRef.id,
      updatedAt: now,
    });

    // Note: Rating updates will be triggered by the onReviewCreated function

    return {
      success: true,
      reviewId: reviewRef.id,
    };

    } catch (error) {
      throw handleError(error);
    }
  }),
);
