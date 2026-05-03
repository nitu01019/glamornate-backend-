import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { ReportReviewInputSchema as ReportReviewSchema } from '@glamornate/contracts';

const db = admin.firestore();

export const reportReview = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'reportReview', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated = ReportReviewSchema.parse(data);
    const { reviewId } = validated;

    const reviewRef = db.collection('reviews').doc(reviewId);
    const reviewDoc = await reviewRef.get();

    if (!reviewDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Review not found');
    }

    const reviewData = reviewDoc.data();
    const reportedBy: string[] = reviewData?.reportedBy || [];

    if (reportedBy.includes(userId)) {
      throw new functions.https.HttpsError('already-exists', 'You have already reported this review');
    }

    await reviewRef.update({
      reportedBy: admin.firestore.FieldValue.arrayUnion(userId),
      reportedCount: admin.firestore.FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    });

    return {
      success: true,
      reviewId,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
