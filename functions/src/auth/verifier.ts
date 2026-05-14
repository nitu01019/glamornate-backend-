/**
 * Thin wrapper around Firebase Admin's `verifyIdToken`. The primary
 * deliverable of this file is the JWKS-pin policy docstring below; the
 * runtime wrapper is conventional and reusable but optional. Callers may
 * continue to invoke `admin.auth().verifyIdToken(token, true)` directly.
 *
 * # JWKS-pin policy (spec §5 Token-security row, 2026-05-12)
 *
 * Firebase Authentication ID tokens are RS256-signed JWTs. The signing
 * keys are published as a JWKS document at:
 *
 *   https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *
 * (the "secure-token signer" endpoint). The Firebase Admin SDK fetches
 * this document transparently when `verifyIdToken` is called, reads the
 * `kid` (key id) from the incoming JWT header, and selects the matching
 * public key for verification. Keys are cached per the response's
 * `Cache-Control` header — in practice ~6 hours per the firebase-admin
 * documentation.
 *
 * # Key rotation policy
 *
 * Google rotates the secure-token signing keys approximately every 24
 * hours. The firebase-admin SDK handles refresh automatically; we do
 * NOT pin keys at the application layer because:
 *
 *   1. Pinning a fixed `kid` would break verification on every legitimate
 *      Google-side rotation (i.e. daily). We would either need to ship a
 *      hot-fix every 24 hours, or accept a window of total auth failure
 *      until the next deploy lands.
 *   2. The SDK already validates the JWKS endpoint over TLS with system
 *      trust roots, and the JWT itself carries the `kid` that selects the
 *      matching key. Application-layer pinning duplicates trust without
 *      adding cryptographic guarantees.
 *   3. App Check (`auth/app-check.ts`) provides the device-attestation
 *      layer that key-pinning would otherwise be intended to defend
 *      against. Even if a forged ID token bypassed JWKS verification, it
 *      would still fail App Check on every `/api/v1/*` route.
 *
 * The `verifyIdToken` call below uses the SDK's built-in ±5-minute clock
 * skew tolerance on `iat`/`exp`/`nbf` claims, which absorbs minor
 * server/device clock drift without weakening the security model.
 *
 * # `checkRevoked = true` rationale
 *
 * OWASP ASVS V3.6.1 ("session revocation on logout") requires that a
 * logged-out session's token be unable to mint new sessions. Firebase's
 * `admin.auth().revokeRefreshTokens(uid)` updates the server-side
 * `validSince` timestamp; subsequent `verifyIdToken(token, true)` calls
 * return `auth/id-token-revoked` if the token was issued before
 * `validSince`. Without `checkRevoked = true`, revoked tokens remain
 * valid for their remaining TTL (≤ 1h).
 *
 * Cost: each call with `checkRevoked = true` issues one Firestore read
 * (the user's `validSince` field). Acceptable overhead for an auth gate.
 */

import * as admin from 'firebase-admin';

export interface VerifyIdTokenOptions {
  /**
   * When true (default), Firebase re-checks the user's `validSince`
   * timestamp on every verification. Set to false ONLY in narrowly-scoped
   * cases where token freshness has already been established within the
   * same request and one extra Firestore read is meaningful.
   */
  checkRevoked?: boolean;
}

/**
 * Strict ID-token verification: rejects tokens that have been revoked via
 * `admin.auth().revokeRefreshTokens(uid)`. See the file-level docstring
 * for JWKS-pinning policy and key-rotation rationale.
 */
export async function verifyIdTokenStrict(
  token: string,
  options: VerifyIdTokenOptions = {},
): Promise<admin.auth.DecodedIdToken> {
  const checkRevoked = options.checkRevoked ?? true;
  return admin.auth().verifyIdToken(token, checkRevoked);
}
