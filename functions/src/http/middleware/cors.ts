/**
 * CORS middleware.
 *
 * Allowlist of origins comes from R2 of the recovery plan:
 *   - https://glamornate.vercel.app (production web)
 *   - https://glamornate.com        (future custom domain)
 *   - https://localhost             (Android Capacitor WebView — androidScheme 'https')
 *   - capacitor://localhost         (iOS Capacitor WebView)
 *   - http://localhost:<port>       (local dev)
 */

import cors from 'cors';
import type { CorsOptions } from 'cors';

const STATIC_ALLOWED_ORIGINS = [
  'https://glamornate.vercel.app',
  'https://glamornate.com',
  'https://localhost',
  'capacitor://localhost',
];

const LOCALHOST_REGEX = /^http:\/\/localhost(:\d+)?$/;

export const ALLOWED_ORIGINS: ReadonlyArray<string | RegExp> = [
  ...STATIC_ALLOWED_ORIGINS,
  LOCALHOST_REGEX,
];

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Server-to-server / curl (no Origin header)
  if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;
  return LOCALHOST_REGEX.test(origin);
}

const corsOptions: CorsOptions = {
  origin(requestOrigin, callback) {
    if (isOriginAllowed(requestOrigin ?? undefined)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin not allowed by CORS: ${requestOrigin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Firebase-AppCheck'],
  maxAge: 600,
};

export const corsMiddleware = cors(corsOptions);
