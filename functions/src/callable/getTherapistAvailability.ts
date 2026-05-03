import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

const GetTherapistAvailabilitySchema = z.object({
  therapistId: z.string(),
  spaId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const getTherapistAvailability = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'getTherapistAvailability', windowMs: 60_000, max: 60 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated = GetTherapistAvailabilitySchema.parse(data);
    const { therapistId, spaId, date } = validated;

    const compositeId = `${spaId}_${date}_${therapistId}`;
    const availDoc = await db.collection('availability').doc(compositeId).get();

    if (!availDoc.exists) {
      return {
        success: true,
        slots: [],
        therapistId,
        spaId,
        date,
      };
    }

    const availData = availDoc.data();
    const slots = (availData?.slots || []).filter(
      (s: { available: boolean }) => s.available
    );

    return {
      success: true,
      slots,
      therapistId,
      spaId,
      date,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
