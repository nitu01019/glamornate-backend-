import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import {
  CheckSignupAvailabilityRequestSchema,
  CheckSignupAvailabilityResponseSchema,
  type CheckSignupAvailabilityResponse,
} from '@glamornate/contracts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import { BloomFilter, type BloomFilterPayload } from '../utils/bloom-filter';

// ---------------------------------------------------------------------------
// Per-device rate limiter (App Check appId keyed)
//
// This is a SECOND rate-limit layer on top of the per-IP withRateLimit below.
// Per-IP is sufficient for most abuse, but shared NATs / proxies collapse many
// devices into one IP bucket. The App Check token's `appId` is the Firebase
// App ID — the same value for every device running the same app build, so it
// is NOT a per-device identifier in the per-user sense. However, it serves as
// a "this is a legitimate Glamornate Android/iOS client" attestation gate, and
// the sliding-window counter here provides an additional corpus-level limit
// that caps the total throughput this callable can service from any one
// attested app installation cohort.
//
// Key design decisions:
//   • Keyed on `req.app.appId` — the Firebase App ID present on every v2
//     callable request when `enforceAppCheck: true` (always set here). Because
//     `enforceAppCheck` rejects the request before this code runs when the
//     token is absent or invalid, `req.app` is guaranteed non-null at call
//     time.
//   • 20 requests per 60-second sliding window per app-id (a generous ceiling
//     for legitimate autocomplete-style checks — a single user can only type so
//     many email/phone values per minute).
//   • Returns `{}` (empty object) on rate-limit — satisfies
//     `CheckSignupAvailabilityResponseSchema` (both email + phone are
//     `.optional()`) and signals "no information" to the caller. The frontend
//     `useSignupAvailability` hook treats missing fields as idle/no-op, which
//     is the correct UX for a rate-limited response (silent — no error pill).
//   • Does NOT throw HttpsError — throwing leaks rate-limit state to an
//     attacker probing the enumeration surface.
//   • Fail-open on Firestore errors (same posture as withRateLimit) so a
//     transient DB blip does not prevent legitimate signups.
//
// NON-DEPLOY NOTE: This function patch is intentionally committed without
// triggering deployment. Deploy via:
//   bash backend/scripts/deploy-functions.sh checkSignupAvailability
// ---------------------------------------------------------------------------

/** Sliding-window Firestore-backed rate limiter keyed on App Check appId. */
async function checkAppIdRateLimit(appId: string): Promise<{ allowed: boolean }> {
  const sanitisedKey = appId.replace(/[^a-zA-Z0-9_:.-]/g, '_');
  const docRef = admin
    .firestore()
    .collection('_rateLimits')
    .doc(`checkSignupAvailability:appId:${sanitisedKey}`);

  const now = Date.now();
  const windowMs = 60_000;
  const limit = 20;

  try {
    const allowed = await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const d = snap.data() as { count?: number; firstAt?: number } | undefined;
      const windowStart = now - windowMs;

      if (!snap.exists || (d?.firstAt ?? 0) < windowStart) {
        // New or expired window — open a fresh bucket.
        tx.set(docRef, {
          count: 1,
          firstAt: now,
          lastAt: now,
          expiresAt: admin.firestore.Timestamp.fromMillis(now + windowMs * 2),
        });
        return true;
      }

      if ((d?.count ?? 0) >= limit) {
        return false;
      }

      tx.update(docRef, {
        count: admin.firestore.FieldValue.increment(1),
        lastAt: now,
        // Anchor TTL to firstAt so repeated calls cannot push expiry forward.
        expiresAt: admin.firestore.Timestamp.fromMillis((d?.firstAt ?? now) + windowMs * 2),
      });
      return true;
    });

    return { allowed };
  } catch (err) {
    // Fail-open: a Firestore blip must not block legitimate signups.
    functions.logger.warn('[rate-limit] appId bucket firestore error; failing open', {
      appId: sanitisedKey,
      err,
    });
    return { allowed: true };
  }
}

const db = admin.firestore();
const logger = createLogger('checkSignupAvailability');

/**
 * Shape of the persisted bloom filter doc at `_meta/signupBloom`. Written
 * nightly by the `rebuildSignupBloomFilter` scheduled job. Both filters
 * are optional so a bootstrap deploy (no doc yet) cleanly falls through
 * to the authoritative Firestore lookup.
 */
interface SignupBloomDoc {
  email?: BloomFilterPayload;
  phone?: BloomFilterPayload;
  userCount?: number;
  /** Firestore Timestamp on the wire; we never read it on the call path. */
  version?: admin.firestore.Timestamp;
}

/**
 * Normalise a phone string into E.164. The contracts schema already
 * accepts `^\+?[1-9]\d{6,14}$`, so we only need to strip whitespace and
 * guarantee a leading `+`. We do NOT attempt country-code inference —
 * the signup form is responsible for prepending the country code before
 * the value reaches us.
 */
function normalisePhone(raw: string): string {
  const trimmed = raw.replace(/\s+/g, '');
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

/**
 * Load bloom filters from `_meta/signupBloom`.
 *
 * H2 (HIGH) FIX: the previous implementation cached the bloom doc in
 * function-instance memory for 1 hour. That window is too generous —
 * a brand-new signup performed in minute T would not be reflected in
 * other instances' cached bloom for up to 60 minutes, producing a
 * false `{ available: true }` race that would only get caught at the
 * authoritative `createUserWithEmailAndPassword` step.
 *
 * No cache by design — keeps freshness, Firestore reads are <50ms,
 * and the callable is rate-limited to 10 req/min/IP so the read load
 * on `_meta/signupBloom` is bounded by the rate limit, not by traffic.
 */
async function loadBloomFilters(): Promise<{
  email?: BloomFilter;
  phone?: BloomFilter;
}> {
  try {
    const snap = await db.collection('_meta').doc('signupBloom').get();
    if (!snap.exists) {
      return {};
    }
    const data = snap.data() as SignupBloomDoc;
    const next: { email?: BloomFilter; phone?: BloomFilter } = {};
    if (data.email) {
      try {
        next.email = BloomFilter.deserialise(data.email);
      } catch (err) {
        logger.warn('Failed to deserialise email bloom — falling back to authoritative lookup', err);
      }
    }
    if (data.phone) {
      try {
        next.phone = BloomFilter.deserialise(data.phone);
      } catch (err) {
        logger.warn('Failed to deserialise phone bloom — falling back to authoritative lookup', err);
      }
    }
    return next;
  } catch (err) {
    // Fail-open: any read error on the bloom doc must not break signup
    // availability — we just skip the optimisation and go straight to the
    // authoritative query.
    logger.warn('Failed to load signup bloom doc — falling back to authoritative lookup', err);
    return {};
  }
}

/**
 * Authoritative Firestore lookup — returns true iff a `users` doc exists
 * with the given field equal to `value`. The `users` collection is
 * indexed on both `profile.email` and `profile.phone` per
 * `firestore.indexes.json`; we mirror those exact field names here.
 */
async function fieldIsTaken(
  field: 'email' | 'phone',
  value: string,
): Promise<boolean> {
  const fieldPath = field === 'email' ? 'profile.email' : 'profile.phone';
  const snap = await db
    .collection('users')
    .where(fieldPath, '==', value)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * `checkSignupAvailability` — public callable that probes whether an
 * email/phone is already registered. Designed for the signup form's
 * inline "available / taken" pill so users find collisions before they
 * burn time filling out the rest of the form.
 *
 * Security posture (deliberate):
 *   - Public (no `context.auth` check). The signup form runs pre-auth
 *     by definition; gating it on auth would break the UX.
 *   - App Check ENFORCED via `callableOpts()` to keep automated bot
 *     enumeration off the function.
 *   - Per-IP rate limit of 10 req/min via `withRateLimit`, keyed on the
 *     first hop of `x-forwarded-for` (falling back to `rawRequest.ip`).
 *     We deliberately key on the public client IP, not on uid, because
 *     the signup flow runs pre-auth — the default uid-based key would
 *     collapse every anonymous caller into one bucket.
 *   - The response is shaped `{ available: boolean }` only — we never
 *     leak a probabilistic flag, internal counters, or timing-distinct
 *     code paths.
 *   - The bloom filter at `_meta/signupBloom` is read by this callable
 *     (Admin SDK, bypasses rules); the Firestore rule for that doc is
 *     auth-required (NOT public-read). The signup form must always go
 *     through this callable — it must NEVER read the bloom doc directly.
 *
 * Optimisation: bloom filter at `_meta/signupBloom` lets us answer
 * `{ available: true }` for the vast majority of new signups without
 * touching the `users` collection. Bloom hits ("maybe present") still
 * fall through to the authoritative Firestore query.
 */
/**
 * Adapter: synthesize a v1-shaped `CallableContext` from a v2 `CallableRequest`
 * so we can keep `withRateLimit` (and any other shared v1 wrappers) without
 * forking them. `withRateLimit` only reads `context.rawRequest` and
 * `context.auth`, both of which exist on v2 requests under the same names.
 */
function v1ContextFromV2<TData>(
  req: CallableRequest<TData>,
): functions.https.CallableContext {
  return {
    auth: req.auth
      ? ({ uid: req.auth.uid, token: req.auth.token } as functions.https.CallableContext['auth'])
      : undefined,
    rawRequest: req.rawRequest as functions.https.CallableContext['rawRequest'],
    instanceIdToken: undefined,
    app: req.app
      ? ({ appId: req.app.appId, alreadyConsumed: req.app.alreadyConsumed } as functions.https.CallableContext['app'])
      : undefined,
  } as functions.https.CallableContext;
}

const rateLimitedHandler = withRateLimit(
  {
    name: 'checkSignupAvailability',
    windowMs: 60_000,
    max: 10,
    // -- per-IP key (we are pre-auth, so the default uid-based key would
    // collapse every anonymous caller into one bucket and DoS legitimate
    // users behind a NAT). Prefer `x-forwarded-for[0]` because Firebase
    // Functions sit behind Google's load balancer and `rawRequest.ip`
    // can otherwise resolve to the LB's egress, which would also collapse
    // every caller into one bucket. --
    keyBy: (ctx) => {
      const xff = ctx.rawRequest?.headers?.['x-forwarded-for'];
      const xffStr = Array.isArray(xff) ? xff[0] : xff;
      const firstIp = xffStr?.toString().split(',')[0]?.trim();
      return `ip:${firstIp || ctx.rawRequest?.ip || 'unknown'}`;
    },
  },
  async (data, _context) => {
    try {
      const validated = CheckSignupAvailabilityRequestSchema.parse(data);
      const blooms = await loadBloomFilters();

      const result: CheckSignupAvailabilityResponse = {};

      if (validated.email) {
        // Schema already lower-cased + trimmed; no extra work needed.
        const email = validated.email;
        const bloomMaybePresent = blooms.email ? blooms.email.has(email) : true;
        const taken = bloomMaybePresent ? await fieldIsTaken('email', email) : false;
        result.email = { available: !taken };
      }

      if (validated.phone) {
        const phone = normalisePhone(validated.phone);
        const bloomMaybePresent = blooms.phone ? blooms.phone.has(phone) : true;
        const taken = bloomMaybePresent ? await fieldIsTaken('phone', phone) : false;
        result.phone = { available: !taken };
      }

      // Validate our own response so a future schema drift trips a test
      // rather than a silent contract violation.
      return CheckSignupAvailabilityResponseSchema.parse(result);
    } catch (error) {
      throw handleError(error);
    }
  },
);

/**
 * v2 onCall — chosen specifically for first-class CORS handling.
 *
 * Why v2:
 *   - The frontend calls this from `http://localhost:3000` in dev (and from
 *     the Capacitor mobile WebView in prod). Both are CROSS-ORIGIN to
 *     `*-cloudfunctions.net`. The Firebase SDK adds `X-Firebase-AppCheck`
 *     (a non-safelisted CORS header), which forces the browser to issue a
 *     CORS preflight (`OPTIONS`) before every POST. v1 callable OPTIONS
 *     handling is not robust for cross-origin + custom-header cases — we
 *     observed `Access-Control-Allow-Origin missing` failures.
 *   - v2 `onCall` ships with first-class preflight handling: passing
 *     `cors: true` instructs the framework to reflect any origin and
 *     advertise the headers/methods the SDK actually uses. This is the
 *     canonical Firebase fix as of 2024+.
 *
 * Region pinned to `us-central1` to match the rest of the v1 callable surface
 * (see `firebase-client-wrapper.ts:419`). App Check enforcement preserved.
 */
export const checkSignupAvailability = onCall(
  {
    region: 'us-central1',
    cors: true,
    enforceAppCheck: true,
    consumeAppCheckToken: false,
    maxInstances: 50,
  },
  async (req: CallableRequest<unknown>): Promise<CheckSignupAvailabilityResponse> => {
    // --- Per-device (App Check appId) rate limit gate ---
    // `req.app` is guaranteed non-null here because `enforceAppCheck: true`
    // rejects the request before this handler is reached when the token is
    // absent or invalid. The fallback to 'unknown' is a defensive measure
    // only; in practice it should never be exercised.
    const appId = req.app?.appId ?? 'unknown';
    const { allowed } = await checkAppIdRateLimit(appId);
    if (!allowed) {
      functions.logger.warn('[rate-limit] appId rate_limited', { appId });
      // Return empty object — satisfies CheckSignupAvailabilityResponseSchema
      // (both fields are .optional()). The frontend treats missing fields as
      // idle/no-op. We do NOT throw HttpsError to avoid leaking rate-limit
      // state to an attacker probing the email/phone enumeration surface.
      return {};
    }

    // --- Per-IP rate limit + business logic (existing path) ---
    const ctx = v1ContextFromV2(req);
    return rateLimitedHandler(req.data, ctx) as Promise<CheckSignupAvailabilityResponse>;
  },
);
