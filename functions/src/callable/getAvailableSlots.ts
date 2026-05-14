import * as functions from 'firebase-functions';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import {
  getAvailability,
  mergeSlotsForServiceDuration,
  calculateAvailabilityForDate,
} from '../utils/availability';
import { handleError } from '../utils/error-handler';

const GetAvailableSlotsSchema = z.object({
  spaId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  serviceDuration: z.number().positive().optional().default(30),
  therapistId: z.string().optional(),
  forceRefresh: z.boolean().optional().default(false),
});

type GetAvailableSlotsInput = z.infer<typeof GetAvailableSlotsSchema>;

export interface Slot {
  start: string;
  end: string;
  duration: number;
  available: boolean;
}

export interface AvailableSlotsResponse {
  success: boolean;
  slots: Slot[];
  date: string;
  spaId: string;
  therapistId?: string;
  cached: boolean;
}

/**
 * Get available slots for a spa/therapist on a specific date
 */
export const getAvailableSlots = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'getAvailableSlots', windowMs: 60_000, max: 60 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated: GetAvailableSlotsInput = GetAvailableSlotsSchema.parse(data);
    const { spaId, date, serviceDuration, therapistId, forceRefresh } = validated;

    let slots: Slot[] = [];
    let cached = true;

    // Try to get cached availability first
    if (!forceRefresh) {
      const availability = await getAvailability(spaId, date, therapistId);

      if (availability) {
        const availableSlots = availability.slots.filter(s => s.available);
        slots = mergeSlotsForServiceDuration(availableSlots, serviceDuration);
        cached = true;
      }
    }

    // If no cached data or force refresh, calculate on the fly. The legacy
    // implementation only invoked `calculateAvailabilityForDate` when
    // `forceRefresh` was true, so a freshly-seeded spa with no cached
    // availability doc surfaced as a permanent "no slots" empty state until
    // the scheduled job ran. Trigger the compute path whenever the cache is
    // empty as well — the slot doc has a 5-minute TTL so subsequent requests
    // hit the cache.
    const shouldRecompute = slots.length === 0 || forceRefresh;
    if (shouldRecompute) {
      await calculateAvailabilityForDate(date, spaId);

      const availability = await getAvailability(spaId, date, therapistId);

      if (availability) {
        const availableSlots = availability.slots.filter(s => s.available);
        slots = mergeSlotsForServiceDuration(availableSlots, serviceDuration);
        cached = false;
      }
    }

    return {
      success: true,
      slots,
      date,
      spaId,
      therapistId,
      cached,
    } as AvailableSlotsResponse;

  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
