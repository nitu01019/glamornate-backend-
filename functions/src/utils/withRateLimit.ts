import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

/**
 * Options accepted by {@link withRateLimit}.
 */
export interface RateLimitOpts {
  /** Unique identifier for this rate limit bucket, e.g. 'createPaymentIntent'. */
  name: string;
  /** Sliding window in milliseconds. */
  windowMs: number;
  /** Max invocations per window per key. */
  max: number;
  /**
   * Key builder. Defaults to `uid:{context.auth.uid}`; falls back to
   * `uid:anon` when the caller is unauthenticated.
   */
  keyBy?: (context: functions.https.CallableContext) => string;
  /**
   * Log-only mode (no rejection) for rollout / tuning. Default false.
   *
   * When true, the helper still records a `[rate-limit] exceeded` warning
   * when the threshold is crossed but lets the request through. Flip to
   * false once Cloud Logging confirms the thresholds are not tripping
   * legitimate traffic.
   */
  logOnly?: boolean;
}

/**
 * Wraps a callable handler with a Firestore-backed rate limiter.
 *
 * Unlike the in-memory limiter at `src/http/middleware/rateLimit.ts`, this
 * helper persists its counters in Firestore (`_rateLimits/{bucket}:{key}`)
 * so it works correctly across Cloud Functions instances. The document
 * shape matches the one written by the frontend register route
 * (`frontend/src/app/api/v1/auth/register/route.ts`) so a future TTL policy
 * on `_rateLimits` covers both writers (see
 * `docs/remediation/PHASE-1-BLOCKERS.md`).
 *
 * Usage:
 *   export const createPaymentIntent = callableOpts().https.onCall(
 *     withRateLimit(
 *       { name: 'createPaymentIntent', windowMs: 60_000, max: 10 },
 *       async (data, context) => { ... },
 *     ),
 *   );
 *
 * The wrapper never burns a second request against the handler — it
 * short-circuits with `resource-exhausted` once the window is full (unless
 * `logOnly` is set, in which case it only warns).
 */
export function withRateLimit<TData, TResult>(
  opts: RateLimitOpts,
  handler: (data: TData, context: functions.https.CallableContext) => Promise<TResult>,
): (data: TData, context: functions.https.CallableContext) => Promise<TResult> {
  const keyBy = opts.keyBy ?? ((ctx: functions.https.CallableContext) => `uid:${ctx.auth?.uid ?? 'anon'}`);

  return async (data, context) => {
    const key = `${opts.name}:${keyBy(context)}`;
    const docRef = admin.firestore().collection('_rateLimits').doc(key);
    const now = Date.now();
    const windowStart = now - opts.windowMs;

    let allowed = true;
    try {
      allowed = await admin.firestore().runTransaction(async (txn) => {
        const snap = await txn.get(docRef);
        const d = snap.data() as { count?: number; firstAt?: number; lastAt?: number } | undefined;

        if (!snap.exists || (d?.firstAt ?? 0) < windowStart) {
          // B3: expiresAt anchors TTL cleanup to firstAt + 2 × windowMs so the
          // Firestore TTL policy on collection-group `_rateLimits` (enabled via
          // gcloud per docs/runbooks/phase-1-user-gates.md §6) can GC rolled-out
          // buckets without racing an in-flight window. The doubled window
          // leaves safe headroom for clock skew.
          txn.set(docRef, {
            count: 1,
            firstAt: now,
            lastAt: now,
            expiresAt: admin.firestore.Timestamp.fromMillis(now + opts.windowMs * 2),
          });
          return true;
        }

        if ((d?.count ?? 0) >= opts.max) {
          return false;
        }

        // Rolling update anchors expiresAt on the original firstAt — not `now` —
        // so a client making repeated requests inside the window cannot keep
        // pushing TTL forward. TTL policy fires consistently based on when the
        // bucket opened.
        const bucketFirstAt = d?.firstAt ?? now;
        txn.update(docRef, {
          count: admin.firestore.FieldValue.increment(1),
          lastAt: now,
          expiresAt: admin.firestore.Timestamp.fromMillis(bucketFirstAt + opts.windowMs * 2),
        });
        return true;
      });
    } catch (err) {
      // Fail-open on Firestore errors so a DB blip does not DoS real users.
      // The frontend register route uses the same fail-open posture; keep
      // them consistent so ops have one alerting story.
      functions.logger.warn('[rate-limit] firestore error; failing open', { key, err });
      allowed = true;
    }

    if (!allowed) {
      functions.logger.warn('[rate-limit] exceeded', { key, name: opts.name });
      if (!opts.logOnly) {
        throw new functions.https.HttpsError(
          'resource-exhausted',
          'Too many requests. Please try again later.',
        );
      }
    }

    return handler(data, context);
  };
}
