/**
 * Bearer ID-token authentication middleware. On success, attaches
 * `req.auth = { uid, token }` to the request for downstream handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import { errResponse } from '../../lib/contracts';

export interface AuthContext {
  uid: string;
  token: admin.auth.DecodedIdToken;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function verifyAuth() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);

    if (!match) {
      res.status(401).json({
        ...errResponse('Missing or malformed Authorization header'),
        code: 'missing-token',
      });
      return;
    }

    try {
      const decoded = await admin.auth().verifyIdToken(match[1], /* checkRevoked */ true);
      req.auth = { uid: decoded.uid, token: decoded };
      next();
    } catch (error: unknown) {
      const firebaseCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      const code =
        firebaseCode === 'auth/id-token-expired'
          ? 'token-expired'
          : firebaseCode === 'auth/id-token-revoked'
            ? 'token-revoked'
            : firebaseCode === 'auth/argument-error' || firebaseCode === 'auth/invalid-id-token'
              ? 'invalid-token'
              : 'auth-failed';
      const message = error instanceof Error ? error.message : 'Token verification failed';
      res.status(401).json({
        ...errResponse(`Authentication failed: ${message}`),
        code,
      });
    }
  };
}
