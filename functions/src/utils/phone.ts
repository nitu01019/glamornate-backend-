/**
 * Single source of truth for phone normalisation across the auth/bloom
 * surface. The same string MUST be produced at every call site that
 * persists, indexes, or probes a user phone number:
 *
 *   - `frontend/src/app/api/v1/auth/register/route.ts` (storage on signup)
 *   - `backend/functions/src/scheduled/rebuildSignupBloomFilter.ts` (writer)
 *   - `backend/functions/src/callable/checkSignupAvailability.ts` (reader)
 *
 * Drift between writer and reader silently breaks the bloom optimisation:
 * the writer would store one byte sequence and the reader would query a
 * different one, so the bloom would always answer "definitely not present"
 * for legitimate collisions and the callable would return a false
 * `{ available: true }`. That was the H1 incident on 2026-05-10 — see
 * the auth/bloom audit doc for full context.
 *
 * Always import from here — DO NOT inline a local copy.
 */

/**
 * Default country code (no leading `+`). India.
 *
 * The signup form stitches `+91` onto a 10-digit input before submission,
 * so the canonical normaliser MUST mirror that exact behaviour for the
 * register-route storage path which currently receives the raw 10-digit
 * value from the FE.
 */
const DEFAULT_COUNTRY_CODE = '91';

/**
 * Normalise a phone string into E.164 form.
 *
 * Behaviour:
 *  - Strips ASCII whitespace.
 *  - Already-prefixed `+...` strings are returned with whitespace removed.
 *  - 7-10 digit strings (no `+`) get the default country code prepended,
 *    matching the FE register form which submits a bare 10-digit number.
 *  - Anything else gets a leading `+` so downstream regex consumers
 *    (E.164 ^\+?[1-9]\d{6,14}$) see a consistent shape.
 *
 * Returns the input unchanged when given a string that is empty or has
 * no digits — the caller is expected to validate via
 * `SignupPhoneSchema` before/after this normalisation.
 */
export function normalisePhone(raw: string): string {
  const trimmed = raw.replace(/\s+/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length >= 7 && digitsOnly.length <= 10) {
    return `+${DEFAULT_COUNTRY_CODE}${digitsOnly}`;
  }
  return `+${digitsOnly}`;
}
