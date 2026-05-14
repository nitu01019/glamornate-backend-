/**
 * revokeMySessions — explicit session-revocation callable (SEC-M2).
 *
 * Called from the frontend sign-out path BEFORE `firebaseSignOut(auth)`.
 * Revokes every refresh token for the calling user so a stolen token —
 * whether already exfiltrated or about to be — can no longer mint new
 * ID tokens.
 *
 * Contract:
 *   - Requires `context.auth` (authenticated).
 *   - No input payload.
 *   - Returns `{ success: true }` on success; throws `internal` with a
 *     sanitised message on failure.
 *
 * Security properties:
 *   - Uses `admin.auth().revokeRefreshTokens(uid)` which updates the
 *     server-side `validSince` — subsequent `verifyIdToken(idToken, true)`
 *     calls with `checkRevoked=true` return `auth/id-token-revoked`.
 *   - The client's cached ID token stays valid for up to its remaining
 *     TTL (≤ 1 h), so callers MUST treat a successful revoke as
 *     "refresh cannot happen" rather than "current token invalidated".
 *   - Does NOT sign the user out on the client — that is the caller's
 *     responsibility (keeps this callable a pure server-side primitive).
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger('revokeMySessions');

/**
 * Firebase Admin error codes that indicate a transient SDK failure rather
 * than a permanent state. We retry these once with a short backoff before
 * propagating an `internal` HttpsError to the caller.
 */
const TRANSIENT_ADMIN_AUTH_CODES = new Set<string>([
  'auth/internal-error',
  'auth/network-request-failed',
]);

const REVOKE_RETRY_BACKOFF_MS = 250;

function isTransientAdminAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_ADMIN_AUTH_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Revoke refresh tokens with a single retry on transient SDK failures.
 *
 * Spec §5 row 2 (echo, 2026-05-12): the callable must retry+log on
 * transient revoke failures rather than silently propagating the first
 * error. If both attempts fail we still throw — the caller decides how
 * to react (the FE sign-out path force-signs-out on `internal`).
 */
async function revokeRefreshTokensWithRetry(uid: string): Promise<void> {
  try {
    await admin.auth().revokeRefreshTokens(uid);
    return;
  } catch (err) {
    if (!isTransientAdminAuthError(err)) {
      throw err;
    }
    logger.warn('revokeRefreshTokens transient failure — retrying once', {
      uid,
      code: (err as { code?: string }).code,
    });
    await sleep(REVOKE_RETRY_BACKOFF_MS);
    await admin.auth().revokeRefreshTokens(uid);
  }
}

/**
 * Inner handler wrapped with the Firestore-backed rate limiter. Pulled out
 * so the outer `onCall` (below) can gate auth BEFORE the rate-limit bucket
 * is touched — see α8-4 on the exported const for the rationale.
 */
const rateLimitedRevoke = withRateLimit(
  // F-DRACO-06 (2026-05-11): legit usage is ≤2/min (sign-out + maybe
  // change-password). 30/min was an unreasoned default — narrow to 5/min
  // per UID to bound revoke-storm cost on a compromised device.
  { name: 'revokeMySessions', windowMs: 60_000, max: 5 },
  async (_data: unknown, context: functions.https.CallableContext) => {
    // Guaranteed non-null by the outer auth-gate on the exported const.
    const uid = context.auth!.uid;

    try {
      await revokeRefreshTokensWithRetry(uid);
      logger.info('Refresh tokens revoked', { uid });
      return { success: true };
    } catch (err) {
      logger.error('revokeMySessions failed', { uid, error: err });
      throw handleError(err);
    }
  },
);

/**
 * Deployed callable: revoke every refresh token for the calling user.
 *
 * @warning Caller lifecycle contract — required follow-up on the client.
 *
 * `admin.auth().revokeRefreshTokens(uid)` updates the server-side
 * `validSince` timestamp; the user's CURRENT cached ID token continues
 * to be accepted by `verifyIdToken(token, false)` (and by any FE code
 * path that does NOT pass `checkRevoked=true`) until its natural TTL
 * (≤ 1 h) expires. The next `getIdToken()` refresh hit the server with
 * the stored refresh token will fail with `auth/id-token-revoked` and
 * the user will be signed out — but until that refresh attempt the
 * session APPEARS still valid.
 *
 * There are two production callers; both MUST adhere to one of these
 * lifecycle patterns:
 *
 * **Pattern 1 — explicit follow-up (used by `revoke-sessions.ts:52`
 * caller, frontend sign-out path):** the client MUST call either
 * `firebaseSignOut(auth)` OR `getIdToken(true)` IMMEDIATELY after the
 * callable resolves. `firebaseSignOut` clears in-memory state; the
 * force-refresh path causes the SDK to call the secure-token endpoint
 * with the (now-revoked) refresh token, which returns
 * `auth/id-token-revoked` and triggers the SDK's `onIdTokenChanged`
 * listener to sign the user out client-side. Without this follow-up
 * the user appears signed-in until token natural expiry; on a stolen
 * device this is a real exposure window.
 *
 * **Pattern 2 — sweep wrapper (used by `utils/cascade-delete.ts:400`
 * caller, called from `auth/delete-account.ts` cascade):** the revoke
 * is part of an account-deletion flow that ALSO deletes
 * `users/{uid}` and emits `onUserDeleted` events. The FE's `useAuth`
 * subscription to that user-doc deletion (frontend route protection
 * sweep) signs the user out independently of token refresh, so no
 * explicit `getIdToken(true)` is needed at this caller.
 *
 * If you add a third caller, route it through Pattern 1 unless the
 * caller already invalidates client-side state by another mechanism.
 *
 * @returns `{ success: true }` on success.
 * @throws `unauthenticated` when `context.auth` is missing.
 * @throws `resource-exhausted` when the per-UID rate-limit bucket is full.
 * @throws `internal` on Firebase Admin SDK failure (after one transient retry).
 *
 * α8-4 (ε6, 2026-05-12): The auth-check is gated BEFORE the rate-limit
 * wrapper so anonymous callers receive `unauthenticated` rather than the
 * `resource-exhausted` produced by the `withRateLimit` default keyer
 * collapsing every anonymous caller into one `uid:anon` bucket
 * (see `utils/withRateLimit.ts:57`).
 *
 * α8-3 (ε6, 2026-05-12): JSDoc lifecycle contract pinned to the exported
 * const (above) so IDE hover surfaces the caller-side follow-up rule.
 */
export const revokeMySessions = callableOpts({ maxInstances: 50 }).https.onCall(
  async (data: unknown, context: functions.https.CallableContext) => {
    // α8-4 — outer auth gate. Throwing here BEFORE invoking
    // `rateLimitedRevoke` ensures anonymous callers get `unauthenticated`
    // (the correct semantic answer) instead of `resource-exhausted` from
    // the shared `uid:anon` bucket.
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Authentication required.',
      );
    }
    return rateLimitedRevoke(data, context);
  },
);
