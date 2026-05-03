import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

const CheckSlotAvailabilitySchema = z.object({
  spaId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  therapistId: z.string().optional(),
});

export const checkSlotAvailability = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'checkSlotAvailability', windowMs: 60_000, max: 60 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated = CheckSlotAvailabilitySchema.parse(data);
    const { spaId, date, startTime, endTime, therapistId } = validated;

    const compositeId = therapistId
      ? `${spaId}_${date}_${therapistId}`
      : `${spaId}_${date}_any`;

    const availDoc = await db.collection('availability').doc(compositeId).get();

    if (!availDoc.exists) {
      return { success: true, available: false, reason: 'No availability data for this date' };
    }

    const availData = availDoc.data();
    const slots = availData?.slots || [];

    const isAvailable = slots.some(
      (slot: { start: string; end: string; available: boolean }) =>
        slot.start <= startTime && slot.end >= endTime && slot.available
    );

    return {
      success: true,
      available: isAvailable,
      spaId,
      date,
      startTime,
      endTime,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
