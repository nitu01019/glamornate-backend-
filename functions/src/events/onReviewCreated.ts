import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { createLogger } from '../utils/logger';

const db = admin.firestore();
const logger = createLogger('onReviewCreated');

/**
 * Minimal zod schema covering only the fields this handler reads from the
 * review doc. `.passthrough()` keeps unknown fields. Malformed docs log and
 * exit early instead of crashing on `.field.foo` access in downstream
 * notification/analytics writes.
 */
const ReviewDocSchema = z
  .object({
    userId: z.string(),
    spaId: z.string().optional(),
    therapistId: z.string().optional(),
    bookingId: z.string().optional(),
    rating: z.number().optional(),
    comment: z.string().optional(),
    title: z.string().optional(),
    aspects: z
      .object({
        ambiance: z.number().optional(),
        service: z.number().optional(),
        therapist: z.number().optional(),
        hygiene: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Triggered when a new review is created.
 * Uses atomic transactions to update spa and therapist ratings,
 * then notifies stakeholders.
 */
export const onReviewCreated = functions.firestore
  .document('reviews/{reviewId}')
  .onCreate(async (snap, context) => {
    const raw = snap.data();
    const { reviewId } = context.params;

    if (!raw) {
      logger.warn('Review created trigger fired but snapshot data is null', { reviewId });
      return null;
    }

    const parsed = ReviewDocSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error('[onReviewCreated] malformed review doc', {
        reviewId,
        error: parsed.error.flatten(),
      });
      return null;
    }
    const review = parsed.data;

    logger.info('Review created', { reviewId, rating: review.rating, spaId: review.spaId });

    const batch = db.batch();

    // 1. Update spa rating atomically
    if (review.spaId) {
      await updateRatingAtomically('spas', review.spaId, 'spa', review);
    }

    // 2. Update therapist rating atomically
    if (review.therapistId) {
      await updateRatingAtomically('therapists', review.therapistId, 'therapist', review);
    }

    // 3. Get reviewer info
    const userDoc = await db.collection('users').doc(review.userId).get();
    const user = userDoc.data();

    // 4. Notify spa owner about new review
    const spaDoc = review.spaId
      ? await db.collection('spas').doc(review.spaId).get()
      : null;
    const spa = spaDoc?.data();

    if (spa?.ownerId) {
      const notificationRef = db.collection('notifications').doc();
      batch.set(notificationRef, {
        userId: spa.ownerId,
        type: 'new_review',
        title: `New ${review.rating}-star Review`,
        body: `${user?.profile?.displayName || 'Someone'} left a review${review.comment ? `: "${review.comment.substring(0, 50)}..."` : ''}`,
        data: {
          reviewId,
          bookingId: review.bookingId,
          rating: review.rating,
          type: 'review_management',
        },
        read: false,
        channels: { push: true, email: true, sms: false },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // 5. Notify therapist if relevant
    if (review.therapistId && review.therapistId !== spa?.ownerId) {
      const therapistNotificationRef = db.collection('notifications').doc();
      batch.set(therapistNotificationRef, {
        userId: review.therapistId,
        type: 'therapist_rating',
        title: `You received a ${review.rating}-star rating!`,
        body: review.title || 'Keep up the great work!',
        data: {
          reviewId,
          bookingId: review.bookingId,
          type: 'therapist',
        },
        read: false,
        channels: { push: true, email: true, sms: false },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    // 6. Log analytics
    await db.collection('analytics').add({
      type: 'review_submitted',
      reviewId,
      bookingId: review.bookingId,
      spaId: review.spaId,
      therapistId: review.therapistId,
      userId: review.userId,
      rating: review.rating,
      aspects: review.aspects,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info('Review processing completed', { reviewId });

    return null;
  });

/**
 * Atomically updates the rating for a spa or therapist using a Firestore transaction.
 *
 * Reads the current ratingSum, ratingCount, and aspect sums from the entity doc,
 * increments them by the new review's values, then writes back the updated
 * averageRating (overall and per-aspect) in a single atomic operation.
 *
 * This replaces the previous read-all-reviews-compute-average pattern which
 * caused race conditions when two triggers fired concurrently on review creation.
 */
async function updateRatingAtomically(
  collection: string,
  entityId: string,
  type: 'spa' | 'therapist',
  review: FirebaseFirestore.DocumentData
): Promise<void> {
  const entityRef = db.collection(collection).doc(entityId);

  await db.runTransaction(async (transaction) => {
    const entitySnap = await transaction.get(entityRef);

    if (!entitySnap.exists) {
      logger.warn(`${type} document not found, skipping rating update`, { entityId });
      return;
    }

    const entity = entitySnap.data() as FirebaseFirestore.DocumentData;

    // Read existing accumulators, defaulting to zero for new entities
    const prevCount: number = entity.rating?.count ?? 0;
    const prevRatingSum: number = entity.rating?.ratingSum ?? (entity.rating?.overall ?? 0) * prevCount;
    const prevAspectSums = {
      ambiance: (entity.rating?.aspectSums?.ambiance ?? (entity.rating?.breakdown?.ambiance ?? 0) * prevCount),
      service: (entity.rating?.aspectSums?.service ?? (entity.rating?.breakdown?.service ?? 0) * prevCount),
      therapist: (entity.rating?.aspectSums?.therapist ?? (entity.rating?.breakdown?.therapist ?? 0) * prevCount),
      hygiene: (entity.rating?.aspectSums?.hygiene ?? (entity.rating?.breakdown?.hygiene ?? 0) * prevCount),
    };

    const newCount = prevCount + 1;
    const newRatingSum = prevRatingSum + (review.rating ?? 0);
    const newAspectSums = {
      ambiance: prevAspectSums.ambiance + (review.aspects?.ambiance ?? 0),
      service: prevAspectSums.service + (review.aspects?.service ?? 0),
      therapist: prevAspectSums.therapist + (review.aspects?.therapist ?? 0),
      hygiene: prevAspectSums.hygiene + (review.aspects?.hygiene ?? 0),
    };

    const overall = newRatingSum / newCount;
    const breakdown = {
      ambiance: newAspectSums.ambiance / newCount,
      service: newAspectSums.service / newCount,
      therapist: newAspectSums.therapist / newCount,
      hygiene: newAspectSums.hygiene / newCount,
    };

    transaction.update(entityRef, {
      rating: {
        overall: Math.round(overall * 10) / 10,
        count: newCount,
        // Persist running sums so future increments remain accurate
        ratingSum: newRatingSum,
        aspectSums: newAspectSums,
        breakdown: {
          ambiance: Math.round(breakdown.ambiance * 10) / 10,
          service: Math.round(breakdown.service * 10) / 10,
          therapist: Math.round(breakdown.therapist * 10) / 10,
          hygiene: Math.round(breakdown.hygiene * 10) / 10,
        },
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info(`${type} rating updated atomically`, { entityId, overall: Math.round(overall * 10) / 10, count: newCount });
  });
}
