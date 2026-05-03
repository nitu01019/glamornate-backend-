import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { todayIST } from '../utils/date-ist';

const db = admin.firestore();

const GetAvailableDatesSchema = z.object({
  spaId: z.string(),
  days: z.number().min(1).max(60).optional().default(14),
  therapistId: z.string().optional(),
});

export const getAvailableDates = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'getAvailableDates', windowMs: 60_000, max: 60 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated = GetAvailableDatesSchema.parse(data);
    const { spaId, days, therapistId } = validated;

    const todayStr = todayIST();
    const today = new Date(`${todayStr}T00:00:00+05:30`);
    const availableDates: string[] = [];

    for (let i = 0; i < days; i++) {
      const searchDate = new Date(today);
      searchDate.setDate(today.getDate() + i);
      const dateStr = searchDate.toISOString().split('T')[0];

      const compositeId = therapistId
        ? `${spaId}_${dateStr}_${therapistId}`
        : `${spaId}_${dateStr}_any`;

      const availDoc = await db.collection('availability').doc(compositeId).get();

      if (!availDoc.exists) continue;

      const slots = availDoc.data()?.slots || [];
      const hasAvailability = slots.some((s: { available: boolean }) => s.available);

      if (hasAvailability) {
        availableDates.push(dateStr);
      }
    }

    return {
      success: true,
      dates: availableDates,
      spaId,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
