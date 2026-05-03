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
import { errResponse } from '../../lib/contracts';

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

export function verifyAppCheck(options: AppCheckOptions = {}) {
  const bypass = options.allowDebugBypass ?? isAppCheckDebugBypassEnabled();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (bypass) {
      next();
      return;
    }

    const token = req.header('X-Firebase-AppCheck');

    if (!token) {
      res
        .status(401)
        .json({ ...errResponse('App Check token missing'), code: 'app-check-failed' });
      return;
    }

    try {
      await admin.appCheck().verifyToken(token);
      next();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'App Check verification failed';
      res
        .status(401)
        .json({
          ...errResponse(`App Check verification failed: ${message}`),
          code: 'app-check-failed',
        });
    }
  };
}
