/**
 * Firebase Secret Manager — central registry (D3).
 *
 * All Firebase callable / event functions that need third-party API
 * credentials MUST import their secrets from this module. Declaring
 * `defineSecret` at module load (rather than inside a handler) lets
 * Firebase bind the secret to the runtime at deploy time — without
 * this binding, `SECRET.value()` returns undefined and the handler
 * falls back to `process.env`, which is unavailable in v1 Cloud
 * Functions unless explicitly attached.
 *
 * Binding: every callable that uses one of these secrets must list it
 * in its `callableOpts({ secrets: [...] })`. Example:
 *
 *     import { SENDGRID_API_KEY } from '../utils/secrets';
 *     export const myFn = callableOpts({
 *       maxInstances: 100,
 *       secrets: [SENDGRID_API_KEY],
 *     }).https.onCall(...)
 *
 * Deploy: the first deploy after adding a new secret will prompt the
 * operator to run `firebase functions:secrets:set <NAME>`. See
 * BLOCKERS.md for rotation notes.
 *
 * NOTE: runtime access via `.value()` throws if the secret is not
 * bound. Callers that want graceful degradation MUST wrap `.value()`
 * in try/catch — we intentionally do NOT catch here so
 * misconfiguration is loud in tests.
 */

import { defineSecret } from 'firebase-functions/params';

// Stripe secrets removed (Phase 1 — Stripe removal, 2026-05-02). Pay-at-spa only.

// ---------------------------------------------------------------------------
// SendGrid (transactional email)
// ---------------------------------------------------------------------------

/** SendGrid API key (SG....). */
export const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

// Twilio: removed M-TWILIO-REMOVE 2026-04-25 — phone OTP via Firebase Auth, push via FCM.

// ---------------------------------------------------------------------------
// Audit log HMAC
// ---------------------------------------------------------------------------

/**
 * Server-side HMAC key used by utils/audit-log.ts to hash PII in audit
 * rows. Rotating this key invalidates pre-existing hashes — document
 * the rotation in `audit_logs` migration notes before rolling.
 * Set via: `firebase functions:secrets:set AUDIT_LOG_HMAC_KEY`.
 */
export const AUDIT_LOG_HMAC_KEY = defineSecret('AUDIT_LOG_HMAC_KEY');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convenience bundle for notifications callables. Individual callables should
 * prefer importing the specific secret they use so the binding list stays
 * minimal (startup-time IAM cost).
 *
 * PAYMENT_SECRETS removed (Phase 1 — Stripe removal, 2026-05-02).
 */
export const NOTIFICATION_SECRETS = [SENDGRID_API_KEY] as const;
