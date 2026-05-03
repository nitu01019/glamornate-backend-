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

export const revokeMySessions = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'revokeMySessions', windowMs: 60_000, max: 30 },
    async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Authentication required.',
      );
    }

    const uid = context.auth.uid;

    try {
      await admin.auth().revokeRefreshTokens(uid);
      logger.info('Refresh tokens revoked', { uid });
      return { success: true };
    } catch (err) {
      logger.error('revokeMySessions failed', { uid, error: err });
      throw handleError(err);
    }
    },
  ),
);
