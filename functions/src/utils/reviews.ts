import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

// ============================================================================
// Review Rating Calculations
// ============================================================================

/**
 * Calculate new rating after a review is added
 */
export interface RatingUpdate {
  userId: string;
  spaId?: string;
  therapistId?: string;
  rating: number;
  aspects?: {
    ambiance: number;
    service: number;
    therapist: number;
    hygiene: number;
  };
}

export async function updateRatings(update: RatingUpdate): Promise<void> {
  // Update spa rating if applicable
  if (update.spaId) {
    const spaRef = db.collection('spas').doc(update.spaId);
    await updateEntityRating(spaRef, update.rating, update.aspects);
  }

  // Update therapist rating if applicable
  if (update.therapistId) {
    const therapistRef = db.collection('therapists').doc(update.therapistId);
    await updateEntityRating(therapistRef, update.rating, update.aspects);
  }
}

async function updateEntityRating(
  docRef: admin.firestore.DocumentReference,
  newRating: number,
  aspects?: { ambiance: number; service: number; therapist: number; hygiene: number }
): Promise<void> {
  const doc = await docRef.get();
  if (!doc.exists) return;

  const data = doc.data();
  const currentRating = data?.rating || { overall: 0, count: 0 };

  const newCount = currentRating.count + 1;
  const newOverall = ((currentRating.overall * currentRating.count) + newRating) / newCount;

  const updateData: Record<string, unknown> = {
    'rating.overall': Math.round(newOverall * 10) / 10,
    'rating.count': newCount,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Update breakdown aspects if provided
  if (aspects && data?.rating?.breakdown) {
    const { breakdown } = data.rating;
    updateData['rating.breakdown'] = {
      ambiance: ((breakdown.ambiance * currentRating.count) + aspects.ambiance) / newCount,
      service: ((breakdown.service * currentRating.count) + aspects.service) / newCount,
      therapist: ((breakdown.therapist * currentRating.count) + aspects.therapist) / newCount,
      hygiene: ((breakdown.hygiene * currentRating.count) + aspects.hygiene) / newCount,
    };
  }

  await docRef.update(updateData);
}

/**
 * Check if user can review (has completed booking and hasn't reviewed yet)
 */
export async function canUserReview(userId: string, bookingId: string): Promise<boolean> {
  const bookingDoc = await db.collection('bookings').doc(bookingId).get();
  if (!bookingDoc.exists) return false;

  const booking = bookingDoc.data();
  if (!booking) return false;

  // Must be customer's booking
  if (booking.userId !== userId) return false;

  // Must be completed
  if (booking.bookingStatus !== 'completed') return false;

  // Must not have review already
  if (booking.reviewId) return false;

  // Check if review already exists for this booking
  const existingReviewQuery = await db.collection('reviews')
    .where('bookingId', '==', bookingId)
    .where('userId', '==', userId)
    .limit(1)
    .get();

  return existingReviewQuery.empty;
}

/**
 * Get reviews for a spa with pagination
 */
export interface GetReviewsParams {
  spaId?: string;
  therapistId?: string;
  limit?: number;
  startAfter?: string;
  rating?: number;
  minRating?: number;
}

export async function getReviews(params: GetReviewsParams): Promise<Array<Record<string, unknown>>> {
  let query: admin.firestore.Query = db.collection('reviews');

  if (params.spaId) {
    query = query.where('spaId', '==', params.spaId);
  }

  if (params.therapistId) {
    query = query.where('therapistId', '==', params.therapistId);
  }

  if (params.minRating) {
    query = query.where('rating', '>=', params.minRating);
  }

  query = query.orderBy('createdAt', 'desc');

  if (params.limit) {
    query = query.limit(params.limit);
  }

  if (params.startAfter) {
    const startDoc = await db.collection('reviews').doc(params.startAfter).get();
    query = query.startAfter(startDoc);
  }

  const snapshot = await query.get();
  return snapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Calculate rating distribution
 */
export interface RatingDistribution {
  5: number;
  4: number;
  3: number;
  2: number;
  1: number;
}

export async function getRatingDistribution(
  spaId?: string,
  therapistId?: string
): Promise<RatingDistribution> {
  let query: admin.firestore.Query = db.collection('reviews');

  if (spaId) {
    query = query.where('spaId', '==', spaId);
  }

  if (therapistId) {
    query = query.where('therapistId', '==', therapistId);
  }

  const snapshot = await query.get();
  const distribution: RatingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

  snapshot.docs.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    const rating = doc.data().rating;
    if (rating >= 1 && rating <= 5) {
      distribution[rating as keyof RatingDistribution]++;
    }
  });

  return distribution;
}

/**
 * Flag review for moderation
 */
export async function flagReview(
  reviewId: string,
  reportedBy: string,
  reason: string
): Promise<void> {
  const reviewRef = db.collection('reviews').doc(reviewId);
  const reviewDoc = await reviewRef.get();

  if (!reviewDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Review not found');
  }

  const review = reviewDoc.data();
  if (!review) {
    throw new functions.https.HttpsError('not-found', 'Review data not found');
  }

  // Add to reportedBy if not already reported
  const reportedByList = review.reportedBy || [];
  if (!reportedByList.includes(reportedBy)) {
    await reviewRef.update({
      reportedBy: admin.firestore.FieldValue.arrayUnion(reportedBy),
      reportedCount: admin.firestore.FieldValue.increment(1),
      moderation: {
        status: reportReviewForModeration((review.reportedCount || 0) + 1) ? 'pending' : 'approved',
        reportedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  }
}

function reportReviewForModeration(count: number): boolean {
  // Flag for moderation if reported by >= 3 users
  return count >= 3;
}

/**
 * Moderate review
 */
export async function moderateReview(
  reviewId: string,
  action: 'approve' | 'reject',
  moderatedBy: string
): Promise<void> {
  const reviewRef = db.collection('reviews').doc(reviewId);

  if (action === 'reject') {
    // Soft delete - mark as inactive
    await reviewRef.update({
      isActive: false,
      moderation: {
        status: 'rejected',
        moderatedBy,
        moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  } else {
    await reviewRef.update({
      moderation: {
        status: 'approved',
        moderatedBy,
        moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  }

  // Recalculate ratings after moderation
  const reviewDoc = await reviewRef.get();
  const review = reviewDoc.data();
  if (!review) return;

  await updateRatings({
    userId: review.userId,
    spaId: review.spaId,
    therapistId: review.therapistId,
    rating: action === 'approve' ? review.rating : 0,
    aspects: review.aspects,
  });
}

/**
 * Mark review as helpful
 */
export async function markReviewHelpful(
  reviewId: string,
  userId: string
): Promise<{ helpfulCount: number; isHelpful: boolean }> {
  const reviewRef = db.collection('reviews').doc(reviewId);
  const reviewDoc = await reviewRef.get();

  if (!reviewDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Review not found');
  }

  const review = reviewDoc.data();
  if (!review) {
    throw new functions.https.HttpsError('not-found', 'Review data not found');
  }
  const helpfulBy = review.helpfulBy || [];
  const isHelpful = helpfulBy.includes(userId);

  if (isHelpful) {
    // Unmark
    await reviewRef.update({
      helpfulBy: admin.firestore.FieldValue.arrayRemove(userId),
      helpfulCount: admin.firestore.FieldValue.increment(-1),
    });
    return { helpfulCount: (review.helpfulCount || 0) - 1, isHelpful: false };
  } else {
    // Mark
    await reviewRef.update({
      helpfulBy: admin.firestore.FieldValue.arrayUnion(userId),
      helpfulCount: admin.firestore.FieldValue.increment(1),
    });
    return { helpfulCount: (review.helpfulCount || 0) + 1, isHelpful: true };
  }
}

/**
 * Get user's reviews
 */
export async function getUserReviews(
  userId: string,
  limit: number = 20
): Promise<Array<Record<string, unknown>>> {
  const snapshot = await db.collection('reviews')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Calculate average rating across multiple aspects
 */
export function calculateAspectAverage(
  aspects: {
    ambiance: number;
    service: number;
    therapist: number;
    hygiene: number;
  }[]
): { ambiance: number; service: number; therapist: number; hygiene: number } {
  if (aspects.length === 0) {
    return { ambiance: 0, service: 0, therapist: 0, hygiene: 0 };
  }

  const sum = aspects.reduce(
    (acc, curr) => ({
      ambiance: acc.ambiance + curr.ambiance,
      service: acc.service + curr.service,
      therapist: acc.therapist + curr.therapist,
      hygiene: acc.hygiene + curr.hygiene,
    }),
    { ambiance: 0, service: 0, therapist: 0, hygiene: 0 }
  );

  const count = aspects.length;

  return {
    ambiance: Math.round((sum.ambiance / count) * 10) / 10,
    service: Math.round((sum.service / count) * 10) / 10,
    therapist: Math.round((sum.therapist / count) * 10) / 10,
    hygiene: Math.round((sum.hygiene / count) * 10) / 10,
  };
}

/**
 * Get review summary for a spa
 */
export async function getReviewSummary(spaId: string): Promise<{
  averageRating: number;
  totalCount: number;
  distribution: RatingDistribution;
  aspects: { ambiance: number; service: number; therapist: number; hygiene: number };
}> {
  const reviews = await getReviews({ spaId });
  const distribution = await getRatingDistribution(spaId);

  const avgRating = reviews.length > 0
    ? reviews.reduce((sum, r) => sum + (typeof r.rating === 'number' ? r.rating : 0), 0) / reviews.length
    : 0;

  type AspectRating = { ambiance: number; service: number; therapist: number; hygiene: number };

  const aspects = calculateAspectAverage(
    reviews
      .filter((r): r is Record<string, unknown> & { aspects: AspectRating } =>
        r.aspects != null &&
        typeof (r.aspects as AspectRating).ambiance === 'number'
      )
      .map(r => r.aspects)
  );

  return {
    averageRating: Math.round(avgRating * 10) / 10,
    totalCount: reviews.length,
    distribution,
    aspects,
  };
}
