import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { formatDateIST } from '../utils/date-ist';

const db = admin.firestore();

const GetAvailabilityCalendarSchema = z.object({
  spaId: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  therapistId: z.string().optional(),
});

export const getAvailabilityCalendar = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'getAvailabilityCalendar', windowMs: 60_000, max: 60 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated = GetAvailabilityCalendarSchema.parse(data);
    const { spaId, startDate, endDate, therapistId } = validated;

    const start = new Date(startDate);
    const end = new Date(endDate);
    const calendar: Array<{ date: string; availableSlots: number; totalSlots: number }> = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDateIST(d);
      const compositeId = therapistId
        ? `${spaId}_${dateStr}_${therapistId}`
        : `${spaId}_${dateStr}_any`;

      const availDoc = await db.collection('availability').doc(compositeId).get();

      if (availDoc.exists) {
        const slots = availDoc.data()?.slots || [];
        const availableSlots = slots.filter((s: { available: boolean }) => s.available).length;
        calendar.push({ date: dateStr, availableSlots, totalSlots: slots.length });
      } else {
        calendar.push({ date: dateStr, availableSlots: 0, totalSlots: 0 });
      }
    }

    return {
      success: true,
      calendar,
      spaId,
      startDate,
      endDate,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
