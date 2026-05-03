import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { MarkReviewHelpfulInputSchema as MarkReviewHelpfulSchema } from '../lib/contracts';

const db = admin.firestore();

export const markReviewHelpful = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'markReviewHelpful', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated = MarkReviewHelpfulSchema.parse(data);
    const { reviewId } = validated;
    const userId = context.auth.uid;

    const reviewRef = db.collection('reviews').doc(reviewId);

    const result = await db.runTransaction(async (transaction) => {
      const reviewDoc = await transaction.get(reviewRef);

      if (!reviewDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Review not found');
      }

      const review = reviewDoc.data();
      if (!review) {
        throw new functions.https.HttpsError('not-found', 'Review data not found');
      }

      if (review.userId === userId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'You cannot mark your own review as helpful'
        );
      }

      const helpfulBy: string[] = review.helpfulBy || [];
      const alreadyVoted = helpfulBy.includes(userId);

      if (alreadyVoted) {
        transaction.update(reviewRef, {
          helpfulBy: admin.firestore.FieldValue.arrayRemove(userId),
          helpfulCount: admin.firestore.FieldValue.increment(-1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { isHelpful: false, helpfulCount: (review.helpfulCount || 0) - 1 };
      } else {
        transaction.update(reviewRef, {
          helpfulBy: admin.firestore.FieldValue.arrayUnion(userId),
          helpfulCount: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { isHelpful: true, helpfulCount: (review.helpfulCount || 0) + 1 };
      }
    });

    return {
      success: true,
      reviewId,
      ...result,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
