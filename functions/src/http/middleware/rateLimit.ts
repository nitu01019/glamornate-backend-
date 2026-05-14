/**
 * In-memory rate limiter.
 *
 * - Public endpoints: 20 requests / 60 s per client IP.
 * - Authenticated endpoints: 60 requests / 60 s per UID.
 *
 * Note: this is a per-instance limiter. Cloud Functions can scale to multiple
 * instances, so the effective cap is `instances * limit`. For hard global
 * limits, swap to Firestore or Memorystore in a follow-up.
 */

import type { Request, Response, NextFunction } from 'express';
import { errResponse } from '../../shared/contracts';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * Callback that extracts the key to bucket requests by. Defaults to client IP.
   */
  keyGenerator?: (req: Request) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Exported for tests — clears all buckets so limiter state doesn't leak
 * across test cases.
 */
export function resetRateLimitBuckets(): void {
  buckets.clear();
}

function defaultKey(req: Request): string {
  // Express's `app.set('trust proxy', 1)` already parses x-forwarded-for and
  // populates `req.ip` with the real client address. Reading the header
  // manually would bypass that trust setting and accept spoofed IPs from any
  // request — so always rely on `req.ip` here.
  return req.ip || 'unknown';
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyGenerator = defaultKey } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Per-IP bucket only: per-route bucketing let an attacker fan out across
    // N routes for `routes × max`/min. The window is shared across all routes.
    const key = keyGenerator(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        ...errResponse('Too many requests. Please try again shortly.'),
        code: 'rate-limited',
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}

export const publicRateLimit = rateLimit({ windowMs: 60_000, max: 20 });

export function authedRateLimit(getUid: (req: Request) => string | undefined) {
  return rateLimit({
    windowMs: 60_000,
    max: 60,
    keyGenerator: (req) => getUid(req) ?? defaultKey(req),
  });
}
