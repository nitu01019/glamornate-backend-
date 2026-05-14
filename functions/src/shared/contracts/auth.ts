/**
 * Shared zod schemas for auth-flow callables (Phase 7).
 *
 * Imported by the backend `checkSignupAvailability` callable AND by the
 * frontend signup form's debounced availability hook. Keeping the wire
 * format here guarantees the two ends stay in lockstep.
 */

import { z } from 'zod';

/**
 * Auth error codes — the canonical wire format for all auth-related
 * failures. FE error-mapper consumes this enum; BE 401 envelope + callable
 * HttpsError chooses values from this enum.
 *
 * Order: HTTP envelope codes first (set by backend/functions/src/auth/
 * middleware.ts), then Firebase HttpsError codes (set by backend/functions/
 * src/auth/*.ts callables).
 */
export const AuthErrorCode = z.enum([
  // BE HTTP envelope (from auth middleware)
  'missing-token',
  'token-expired',
  'token-revoked',
  'invalid-token',
  'auth-failed',
  'transient-auth-failure',
  'app-check-failed',
  // Firebase HttpsError (from auth callables)
  'unauthenticated',
  'permission-denied',
  'not-found',
  'invalid-argument',
  'failed-precondition',
  'resource-exhausted',
  'internal',
]);

export type AuthErrorCode = z.infer<typeof AuthErrorCode>;

/**
 * E.164 phone — leading `+`, country code (1-9), 6-14 digits afterwards.
 *
 * We intentionally accept the `+`-less form too because the signup form
 * may not have prepended the country code yet; the callable normalises
 * to E.164 server-side before the Firestore lookup.
 */
const E164_RE = /^\+?[1-9]\d{6,14}$/;

/** Email field: lower-cased, trimmed, RFC-valid. */
export const SignupEmailSchema = z.string().trim().toLowerCase().email();

/** Phone field: E.164-shaped (with or without leading `+`). */
export const SignupPhoneSchema = z.string().trim().regex(E164_RE);

/**
 * `checkSignupAvailability` request shape — at least one of `email` or
 * `phone` must be supplied. Refine ensures we never burn a Firestore
 * query on an empty payload.
 */
export const CheckSignupAvailabilityRequestSchema = z
  .object({
    email: SignupEmailSchema.optional(),
    phone: SignupPhoneSchema.optional(),
  })
  .refine((d) => Boolean(d.email) || Boolean(d.phone), {
    message: 'At least one of email or phone is required',
  });

export type CheckSignupAvailabilityRequest = z.infer<
  typeof CheckSignupAvailabilityRequestSchema
>;

/** Per-field availability result. `available: false` means the value already exists. */
export const SignupAvailabilityFieldSchema = z.object({
  available: z.boolean(),
});
export type SignupAvailabilityField = z.infer<typeof SignupAvailabilityFieldSchema>;

/**
 * `checkSignupAvailability` response shape — the response only includes
 * the fields that were probed. The shape matches the request 1:1.
 */
export const CheckSignupAvailabilityResponseSchema = z.object({
  email: SignupAvailabilityFieldSchema.optional(),
  phone: SignupAvailabilityFieldSchema.optional(),
});

export type CheckSignupAvailabilityResponse = z.infer<
  typeof CheckSignupAvailabilityResponseSchema
>;

/**
 * User-keyed collections — the canonical list of top-level Firestore
 * collections that carry a `userId` field referencing `users/{uid}`.
 *
 * Single source of truth for any operation that must enumerate all
 * locations user-owned data can live in. Currently consumed by:
 *
 *   • `auth/merge-accounts.ts` — reassigns docs from secondary → primary
 *     uid when an admin merges two accounts.
 *
 * Adding a new userId-keyed collection? Add it here AND in the FE mirror
 * (the byte-identical drift test will fail otherwise) so the merge sweep
 * picks it up automatically. Forgetting this list silently orphans data.
 *
 * Subcollections of `users/{uid}/...` (e.g., `addresses`, `favorites`)
 * are intentionally OUT of scope — they're scoped under the user doc and
 * handled by their own archival logic.
 */
export const USER_KEYED_COLLECTIONS = [
  'bookings',
  'notifications',
  'wallet',
  'walletTransactions',
  'reviews',
  'userVouchers',
  'supportTickets',
  'fcmTokens',
] as const;

export type UserKeyedCollection = (typeof USER_KEYED_COLLECTIONS)[number];
