/**
 * Shared business constants for the Glamornate backend.
 * Centralizes magic numbers to avoid duplication across modules.
 */

/** Duration a booking draft is held before auto-cancellation (in milliseconds). */
export const BOOKING_HOLD_DURATION_MS = 15 * 60 * 1000;

/** Duration a booking draft is held before auto-cancellation (in seconds). */
export const BOOKING_HOLD_DURATION_SECONDS = 900;

/**
 * Server-side floor: `createBooking` rejects any slot whose UTC start is
 * less than this many milliseconds in the future. Strictly narrower than the
 * client's 60-minute UX filter (`BOOKING_LEAD_TIME_MIN`) — see ADR
 * 0008-booking-lead-time-asymmetry.md.
 *
 * Plan §Phase 7. Council-corrected from v2's accidentally inverted 30-min
 * server / 60-min client to the intended 5-min server / 60-min client.
 */
export const SERVER_BOOKING_LEAD_TIME_MS = 5 * 60 * 1000;
