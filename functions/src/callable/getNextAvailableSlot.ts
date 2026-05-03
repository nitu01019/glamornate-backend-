import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { todayIST } from '../utils/date-ist';

const db = admin.firestore();

const GetNextAvailableSlotSchema = z.object({
  spaId: z.string(),
  serviceDuration: z.number().positive().optional().default(30),
  therapistId: z.string().optional(),
  daysToSearch: z.number().min(1).max(30).optional().default(7),
});

export const getNextAvailableSlot = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'getNextAvailableSlot', windowMs: 60_000, max: 60 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated = GetNextAvailableSlotSchema.parse(data);
    const { spaId, serviceDuration, therapistId, daysToSearch } = validated;

    const todayStr = todayIST();
    const today = new Date(`${todayStr}T00:00:00+05:30`);

    for (let i = 0; i < daysToSearch; i++) {
      const searchDate = new Date(today);
      searchDate.setDate(today.getDate() + i);
      const dateStr = searchDate.toISOString().split('T')[0];

      const compositeId = therapistId
        ? `${spaId}_${dateStr}_${therapistId}`
        : `${spaId}_${dateStr}_any`;

      const availDoc = await db.collection('availability').doc(compositeId).get();

      if (!availDoc.exists) continue;

      const slots = availDoc.data()?.slots || [];
      const availableSlot = slots.find(
        (s: { available: boolean; start: string; end: string }) => {
          if (!s.available) return false;
          const startMinutes = parseInt(s.start.split(':')[0]) * 60 + parseInt(s.start.split(':')[1]);
          const endMinutes = parseInt(s.end.split(':')[0]) * 60 + parseInt(s.end.split(':')[1]);
          return (endMinutes - startMinutes) >= serviceDuration;
        }
      );

      if (availableSlot) {
        return {
          success: true,
          found: true,
          date: dateStr,
          slot: availableSlot,
          spaId,
        };
      }
    }

    return {
      success: true,
      found: false,
      spaId,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
