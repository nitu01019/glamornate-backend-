/**
 * Bearer ID-token authentication middleware. On success, attaches
 * `req.auth = { uid, token }` to the request for downstream handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { errResponse } from '../shared/contracts';
import type { AuthErrorCodeT } from './error-codes';

export interface AuthContext {
  uid: string;
  token: admin.auth.DecodedIdToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

// 2026-05-11 (B-EC-02 / T3-F14): RFC 6750 §3 + RFC 9110 §15.5.2 require
// 401 responses to include `WWW-Authenticate`. The `Bearer` scheme with
// `realm` and `error` params lets Bearer-token clients respect the
// challenge protocol (some clients refuse to retry without it).
function sendUnauthorized(
  res: Response,
  req: Request,
  code: AuthErrorCodeT,
  message: string,
  errorKind: 'invalid_request' | 'invalid_token',
): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="api", error="${errorKind}"`,
  );
  // 2026-05-11 (Lens-D4 / T3-F14): structured log on every 401 so on-call
  // can detect token-revoke storms or auth-misconfig. No PII (uid logged
  // only if available; the BE logger scrubs email/phone/etc).
  functions.logger.warn('[auth] 401 unauthenticated', {
    code,
    route: req.path,
    method: req.method,
  });
  res.status(401).json({
    ...errResponse(message),
    code,
  });
}

// α2-1 (2026-05-12): transient Firebase Admin SDK failures (KMS unreachable,
// googleapis 5xx, network blips) used to collapse into `code:'auth-failed'`
// 401, which FE treats as "bad token → redirect to login". The fix is to
// classify by `firebaseCode` and respond 503 + Retry-After so the FE retries
// with backoff rather than signing the user out.
function isTransientFirebaseAuthError(firebaseCode: string): boolean {
  return (
    firebaseCode === 'auth/internal-error' ||
    firebaseCode === 'auth/network-request-failed' ||
    firebaseCode === 'auth/too-many-requests'
  );
}

export function verifyAuth() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);

    if (!match) {
      sendUnauthorized(
        res,
        req,
        'missing-token',
        'Missing or malformed Authorization header',
        'invalid_request',
      );
      return;
    }

    // α2-2 (2026-05-12): capture the decoded result INSIDE the try, but call
    // `next()` OUTSIDE so a downstream synchronous throw cannot be
    // misclassified as `auth-failed` 401 by this catch block. Standard
    // Express pattern.
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(match[1], /* checkRevoked */ true);
    } catch (error: unknown) {
      const firebaseCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';

      // α2-1 (2026-05-12): transient SDK failures → 503 + Retry-After so FE
      // retries with backoff instead of redirect-to-login.
      if (isTransientFirebaseAuthError(firebaseCode)) {
        functions.logger.warn('[auth] 503 transient', {
          firebaseCode,
          route: req.path,
          method: req.method,
        });
        res.setHeader('Retry-After', '5');
        const transientCode: AuthErrorCodeT = 'transient-auth-failure';
        res.status(503).json({
          ...errResponse('Authentication temporarily unavailable'),
          code: transientCode,
        });
        return;
      }

      const code: AuthErrorCodeT =
        firebaseCode === 'auth/id-token-expired'
          ? 'token-expired'
          : firebaseCode === 'auth/id-token-revoked'
            ? 'token-revoked'
            : firebaseCode === 'auth/argument-error' || firebaseCode === 'auth/invalid-id-token'
              ? 'invalid-token'
              : 'auth-failed';
      // 2026-05-11 (Cipher-D16 / T3-F36): the Firebase Admin SDK's error
      // message includes diagnostic strings ("Firebase ID token has
      // incorrect 'aud' (audience) claim. Expected 'project-id' but got
      // 'other-project'.") that leak project ID to anonymous callers.
      // Drop the interpolation; the static envelope is sufficient.
      sendUnauthorized(res, req, code, 'Authentication failed', 'invalid_token');
      return;
    }

    req.auth = { uid: decoded.uid, token: decoded };

    // α1-5 (2026-05-12): post-success structured log so on-call can correlate
    // 200 responses with the authenticated principal. No PII; uid is OK per
    // the existing logger-scrub convention used in sendUnauthorized().
    functions.logger.info('[auth] 200 verified', {
      uid: decoded.uid,
      route: req.path,
      method: req.method,
    });

    next();
  };
}
