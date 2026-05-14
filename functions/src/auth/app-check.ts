/**
 * Firebase App Check verification middleware.
 *
 * All public `/api/v1/*` HTTP endpoints require a valid App Check token in
 * the `X-Firebase-AppCheck` header. Enforcement is globally gated by
 * `ALLOW_APP_CHECK_DEBUG=true`, which is honoured only in emulator/test
 * environments.
 */

import type { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import { errResponse } from '../shared/contracts';

export interface AppCheckOptions {
  /**
   * Override environment-based bypass. Primarily used in tests; do not set in
   * production.
   */
  allowDebugBypass?: boolean;
}

export function isAppCheckDebugBypassEnabled(): boolean {
  return process.env.ALLOW_APP_CHECK_DEBUG === 'true';
}

/**
 * Soft-enforce mode: when `APP_CHECK_ENFORCED=false`, missing or invalid
 * tokens are logged but the request still passes through. This mirrors the
 * project-level UNENFORCED state (gcloud firebaseappcheck services PATCH
 * enforcementMode=UNENFORCED) so that sideloaded APKs whose Play Integrity
 * tokens are rate-limited or rejected by Google can still reach the BE.
 *
 * Distinct from `ALLOW_APP_CHECK_DEBUG` — that one is blocked at startup in
 * production-shaped envs. This flag is safe to set in prod when the project
 * is intentionally running with App Check off (pre-Play-Console state).
 */
export function isAppCheckSoftEnforceEnabled(): boolean {
  return process.env.APP_CHECK_ENFORCED === 'false';
}

export function verifyAppCheck(options: AppCheckOptions = {}) {
  const bypass = options.allowDebugBypass ?? isAppCheckDebugBypassEnabled();
  const softEnforce = isAppCheckSoftEnforceEnabled();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (bypass) {
      next();
      return;
    }

    const token = req.header('X-Firebase-AppCheck');

    if (!token) {
      if (softEnforce) {
        // eslint-disable-next-line no-console
        console.warn('[app-check] missing token (soft-enforce; request allowed)', {
          path: req.path,
        });
        next();
        return;
      }
      res.status(401).json({
        ...errResponse('App Check token missing'),
        code: 'app-check-failed',
        // A-6-11: propagate explicit reason so the FE wrapper branches
        // deterministically instead of pattern-matching error messages.
        details: { reason: 'app-check' },
      });
      return;
    }

    try {
      await admin.appCheck().verifyToken(token);
      next();
    } catch (_error: unknown) {
      if (softEnforce) {
        // eslint-disable-next-line no-console
        console.warn('[app-check] invalid token (soft-enforce; request allowed)', {
          path: req.path,
        });
        next();
        return;
      }
      // F-CG-04 (2026-05-11): do NOT interpolate the SDK error message into
      // the wire response. App Check SDK messages can include rotation hints
      // or verifier-internal details that an anonymous caller has no need
      // for. FE branches on `code` + `details.reason`, never on the
      // human-readable `error` string — matches the auth.ts hardening.
      res.status(401).json({
        ...errResponse('App Check verification failed'),
        code: 'app-check-failed',
        // A-6-11: explicit reason for FE deterministic branching.
        details: { reason: 'app-check' },
      });
    }
  };
}
