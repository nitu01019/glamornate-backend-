/**
 * Shared zod schemas for auth-flow callables (Phase 7).
 *
 * Imported by the backend `checkSignupAvailability` callable AND by the
 * frontend signup form's debounced availability hook. Keeping the wire
 * format here guarantees the two ends stay in lockstep.
 */

import { z } from 'zod';

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
