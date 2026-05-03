import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';

export const IST_TIMEZONE = 'Asia/Kolkata';

export function todayIST(): string {
  return formatInTimeZone(new Date(), IST_TIMEZONE, 'yyyy-MM-dd');
}

export function nowIST(): Date {
  return toZonedTime(new Date(), IST_TIMEZONE);
}

export function formatDateIST(date: Date, pattern: string = 'yyyy-MM-dd'): string {
  return formatInTimeZone(date, IST_TIMEZONE, pattern);
}

/**
 * Compose an IST date string + IST HH:MM into the corresponding UTC `Date`
 * instant. Used by `createBooking` so the slot's start/end are anchored to
 * the same wall-clock moment the user picked, irrespective of the runtime's
 * `process.env.TZ`. Mirror of `frontend/src/lib/date-ist.ts`.
 *
 * Plan §Phase 2.
 */
export function istDateAtTimeToUtc(dateStr: string, timeHHMM: string): Date {
  return fromZonedTime(`${dateStr} ${timeHHMM}:00`, IST_TIMEZONE);
}
