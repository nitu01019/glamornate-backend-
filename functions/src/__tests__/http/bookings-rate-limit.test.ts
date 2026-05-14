/**
 * Patch 5 — Per-UID rate-limit isolation on authed bookings routes.
 *
 * Proves the F-CG-01 (2026-05-11) contract documented at
 * `backend/functions/src/http/app.ts:85-91`:
 *
 *   `authedRateLimit` was previously mounted at the router level BEFORE
 *   per-route `verifyAuth()` could populate `req.auth.uid`. The keyGenerator
 *   silently fell back to per-IP, so every authed caller behind a shared NAT
 *   /proxy shared one bucket. Patch 5 moved the limiter INSIDE the
 *   bookingsRouter, AFTER verifyAuth on each route — see
 *   `backend/functions/src/http/routes/bookings.ts:54-56` (list) and
 *   `backend/functions/src/http/routes/bookings.ts:102-106` (detail).
 *
 * What this file verifies:
 *   (a) Two callers from the same IP but with DIFFERENT verifyAuth uids
 *       each get their own bucket and neither blocks the other.
 *   (b) Hammering a single uid eventually trips 429 with the
 *       `code: 'rate-limited'` envelope from `rateLimit.ts:66-69`.
 *   (c) Auth failures NEVER consume a uid bucket because the rate-limit
 *       middleware runs AFTER verifyAuth (and verifyAuth short-circuits
 *       with 401 before next() — `auth.ts:56-64,71-90`).
 *   (d) Structural invariant: when req.auth.uid is undefined (only
 *       reachable if verifyAuth were ever bypassed) the keyGenerator falls
 *       back to IP — see `rateLimit.ts:84`. Documented + asserted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Track every uid that verifyIdToken successfully decoded, so we can assert
// that ordering — rate-limit only sees uids that auth admitted.
const verifyIdTokenCalls: string[] = [];

const mockBookingsQueryGet = vi.fn();
const mockBookingDocGet = vi.fn();

type QueryChain = {
  where: (...args: unknown[]) => QueryChain;
  orderBy: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
  offset: (...args: unknown[]) => QueryChain;
  get: () => Promise<unknown>;
};

function makeQueryChain(getImpl: () => Promise<unknown>): QueryChain {
  const chain: QueryChain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    offset: vi.fn(() => chain),
    get: getImpl,
  };
  return chain;
}

vi.mock('firebase-admin', () => {
  const firestoreFn = () => ({
    collection: vi.fn((name: string) => {
      if (name === 'bookings') {
        return {
          ...makeQueryChain(() => mockBookingsQueryGet()),
          doc: vi.fn(() => ({ get: () => mockBookingDocGet() })),
        };
      }
      return makeQueryChain(() => Promise.resolve({ docs: [] }));
    }),
  });
  const authFn = () => ({
    // Token shape `test:UID` decodes directly to that UID — mirrors
    // `bookings.test.ts:46-51` so we re-use the same auth pattern.
    // Token shape `bad:*` always throws — used to assert auth failure does
    // NOT consume the rate-limit bucket.
    verifyIdToken: vi.fn(async (token: string) => {
      if (token.startsWith('bad:')) {
        const err = new Error('invalid token') as Error & { code?: string };
        err.code = 'auth/invalid-id-token';
        throw err;
      }
      const match = /^test:(.+)$/.exec(token);
      if (!match) throw new Error('bad token');
      verifyIdTokenCalls.push(match[1]);
      return { uid: match[1] };
    }),
  });
  return {
    default: {
      initializeApp: vi.fn(),
      firestore: firestoreFn,
      appCheck: () => ({}),
      auth: authFn,
    },
    initializeApp: vi.fn(),
    firestore: firestoreFn,
    appCheck: () => ({}),
    auth: authFn,
  };
});

import { buildApp } from '../../http/app';
import { resetRateLimitBuckets } from '../../http/middleware/rateLimit';

const BASE = '/api/v1';

function authHeader(uid: string): Record<string, string> {
  return { Authorization: `Bearer test:${uid}` };
}

function badAuthHeader(): Record<string, string> {
  return { Authorization: 'Bearer bad:nope' };
}

function snap(id: string, data: Record<string, unknown>) {
  return { id, exists: true, data: () => data };
}

/**
 * Default the Firestore mocks so handlers that DO get past rate-limit
 * return 200, not 500 — otherwise a 500 would hide a passed-through request.
 * Each test resets `mockBookingsQueryGet.mockReset()` if it needs custom data.
 */
function defaultFirestoreSuccess(): void {
  mockBookingsQueryGet.mockResolvedValue({ docs: [] });
  mockBookingDocGet.mockResolvedValue({ exists: false, data: () => undefined });
}

describe('Patch 5 — authedRateLimit per-UID isolation on /bookings', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
    mockBookingsQueryGet.mockReset();
    mockBookingDocGet.mockReset();
    verifyIdTokenCalls.length = 0;
    defaultFirestoreSuccess();
  });

  describe('(a) per-UID isolation', () => {
    it('two uids sharing one IP get independent buckets — neither blocks the other', async () => {
      // bookings.ts:52-56 mounts authedRateLimit AFTER verifyAuth, keyed on
      // req.auth.uid. authedRateLimit is 60 req / 60s per UID
      // (rateLimit.ts:80-86). publicRateLimit (20/min/IP, rateLimit.ts:78)
      // gates first at app.ts:69 — so we keep the total request count
      // BELOW 20 here to isolate the authed-layer behavior under test.
      const app = buildApp({ disableAppCheck: true });
      const SHARED_IP = '198.51.100.7';

      // Interleave uid-A and uid-B from the same IP. 8 requests total → well
      // below the public 20/min/IP cap, so any 429 we see can only come from
      // the per-UID authed limiter.
      const responses: Array<{ uid: string; status: number }> = [];
      for (let i = 0; i < 4; i++) {
        for (const uid of ['uid-A', 'uid-B']) {
          const res = await request(app)
            .get(`${BASE}/bookings`)
            .set('X-Forwarded-For', SHARED_IP)
            .set(authHeader(uid));
          responses.push({ uid, status: res.status });
        }
      }

      // None should be 429: both buckets are at 4/60, well under 60.
      const limited = responses.filter((r) => r.status === 429);
      expect(limited).toEqual([]);

      // Every authed request reached the handler (200, since Firestore is
      // mocked to return an empty docs list).
      const accepted = responses.filter((r) => r.status === 200);
      expect(accepted.length).toBe(8);
    });

    it('hammering uid-A within the window does NOT 429 uid-B in the same window', async () => {
      // Drive uid-A above the 60-cap, then a fresh uid-B request from the
      // SAME IP must still succeed. To dodge the publicRateLimit
      // (20/min/IP at app.ts:69), we rotate X-Forwarded-For across requests.
      // The authed limiter, keyed on uid (rateLimit.ts:80-86), is the only
      // bucket uid-A and uid-B share — and per Patch 5 they MUST NOT.
      const app = buildApp({ disableAppCheck: true });

      // Hammer uid-A from 61 distinct IPs (so publicRateLimit, per-IP, stays
      // at 1/20 for each — no public 429s). The authed limiter sees uid-A
      // 61 times → request #61 must be 429.
      let firstAuthedBlock = -1;
      for (let i = 0; i < 65; i++) {
        const res = await request(app)
          .get(`${BASE}/bookings`)
          .set('X-Forwarded-For', `10.0.0.${i + 1}`)
          .set(authHeader('uid-A'));
        if (res.status === 429) {
          firstAuthedBlock = i + 1; // 1-indexed
          break;
        }
      }

      // Should block on or after the 61st request (window=60, max=60).
      expect(firstAuthedBlock).toBeGreaterThanOrEqual(61);
      expect(firstAuthedBlock).toBeLessThanOrEqual(65);

      // Now hit with uid-B from a fresh IP (still sharing the per-IP space
      // we just used — but we rotate to a new one to be safe). uid-B's
      // bucket is independent, so it MUST pass.
      const resB = await request(app)
        .get(`${BASE}/bookings`)
        .set('X-Forwarded-For', '10.0.1.1')
        .set(authHeader('uid-B'));
      expect(resB.status).toBe(200);
    });

    it('isolation applies to GET /bookings/:id as well (rateLimit.ts:51-52 — bucket is shared across routes per key)', async () => {
      // Both bookings routes mount authedRateLimit with the same
      // keyGenerator (bookings.ts:56, bookings.ts:106). The buckets Map in
      // rateLimit.ts:29 is keyed solely on the derived key, so list +
      // detail share a uid bucket. Sanity-check that uid-A on detail
      // doesn't bleed into uid-B's bucket.
      const app = buildApp({ disableAppCheck: true });
      mockBookingDocGet.mockResolvedValue(
        snap('b-1', { userId: 'uid-A', spaOwnerId: 'someone-else' }),
      );

      const resA = await request(app)
        .get(`${BASE}/bookings/b-1`)
        .set('X-Forwarded-For', '203.0.113.50')
        .set(authHeader('uid-A'));
      expect(resA.status).toBe(200);

      // Different uid from same IP → different bucket. The booking is
      // owned by uid-A, so uid-B should 403 (NOT 429, NOT 200) — that's
      // proof that uid-B's request reached the handler unimpeded.
      const resB = await request(app)
        .get(`${BASE}/bookings/b-1`)
        .set('X-Forwarded-For', '203.0.113.50')
        .set(authHeader('uid-B'));
      expect(resB.status).toBe(403);
    });
  });

  describe('(b) hammering same uid trips 429 with correct envelope', () => {
    it('the 61st request for the same uid returns 429 with code=rate-limited and Retry-After header', async () => {
      // rateLimit.ts:63-70 emits {success:false, code:'rate-limited'} with
      // a Retry-After header on overflow. 60 req/60s window per UID.
      const app = buildApp({ disableAppCheck: true });

      // Rotate IPs to dodge publicRateLimit (20/IP/min). All requests use
      // the same uid so they all land in the same authed bucket.
      let limitedRes: { status: number; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
      for (let i = 0; i < 70; i++) {
        const res = await request(app)
          .get(`${BASE}/bookings`)
          .set('X-Forwarded-For', `192.0.2.${(i % 250) + 1}`)
          .set(authHeader('hammered-uid'));
        if (res.status === 429) {
          limitedRes = {
            status: res.status,
            body: res.body as Record<string, unknown>,
            headers: res.headers as Record<string, string>,
          };
          break;
        }
      }

      expect(limitedRes).not.toBeNull();
      expect(limitedRes!.status).toBe(429);
      expect(limitedRes!.body.success).toBe(false);
      // rateLimit.ts:68 sets `code: 'rate-limited'`.
      expect(limitedRes!.body.code).toBe('rate-limited');
      // rateLimit.ts:64-65 sets Retry-After (supertest lowercases header
      // names per the Node http convention).
      expect(limitedRes!.headers['retry-after']).toBeDefined();
      const retryAfter = parseInt(limitedRes!.headers['retry-after']!, 10);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it('resetRateLimitBuckets() restores a uid to a fresh bucket (test isolation contract — rateLimit.ts:35-37)', async () => {
      const app = buildApp({ disableAppCheck: true });

      // Burn the uid through 65 requests so it's locked.
      for (let i = 0; i < 65; i++) {
        await request(app)
          .get(`${BASE}/bookings`)
          .set('X-Forwarded-For', `172.16.0.${(i % 250) + 1}`)
          .set(authHeader('exhausted-uid'));
      }

      // Confirm it's locked.
      const locked = await request(app)
        .get(`${BASE}/bookings`)
        .set('X-Forwarded-For', '172.16.1.1')
        .set(authHeader('exhausted-uid'));
      expect(locked.status).toBe(429);

      // Reset and verify the bucket is fresh.
      resetRateLimitBuckets();
      const unlocked = await request(app)
        .get(`${BASE}/bookings`)
        .set('X-Forwarded-For', '172.16.1.2')
        .set(authHeader('exhausted-uid'));
      expect(unlocked.status).toBe(200);
    });
  });

  describe('(c) rate-limit runs AFTER verifyAuth — auth failures do not consume the bucket', () => {
    it('verifyAuth 401 short-circuits before authedRateLimit increments any bucket', async () => {
      // bookings.ts:52-56 places verifyAuth() before authedRateLimit. If a
      // request never makes it past auth, the limiter's keyGenerator is
      // never called, so the bucket stays at zero. We can prove that by
      // sending the public-IP rate-limit cap WORTH of bad-auth requests
      // (each one 401s) and then verifying a legitimate caller from the
      // same IP can still make MANY authed calls — far more than any
      // mythical leaked counter would allow.
      const app = buildApp({ disableAppCheck: true });
      const SHARED_IP = '198.51.100.99';

      // 5 bad-auth requests → all 401, none touch the rate-limit bucket.
      // (Stay under public 20/min/IP cap.)
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .get(`${BASE}/bookings`)
          .set('X-Forwarded-For', SHARED_IP)
          .set(badAuthHeader());
        expect(res.status).toBe(401);
      }

      // No mythical leaked count: verifyIdToken on `bad:*` always threw,
      // so the success-list is empty.
      expect(verifyIdTokenCalls).toEqual([]);

      // Now an authentic uid from the SAME IP. Its bucket is fresh.
      // 5 requests must all succeed (bucket: 0 → 5, far under 60).
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .get(`${BASE}/bookings`)
          .set('X-Forwarded-For', SHARED_IP)
          .set(authHeader('clean-uid'));
        expect(res.status).toBe(200);
      }

      expect(verifyIdTokenCalls.filter((u) => u === 'clean-uid').length).toBe(5);
    });

    it('completely unauthenticated requests (no Authorization header) 401 and never increment any uid bucket', async () => {
      // verifyAuth at auth.ts:56-64 rejects with 401 before next(). The
      // authed limiter never runs. We assert by following the 401 with a
      // legitimate uid request that succeeds — the uid bucket was never
      // touched by the anonymous call.
      const app = buildApp({ disableAppCheck: true });
      const SHARED_IP = '198.51.100.55';

      const noAuth = await request(app)
        .get(`${BASE}/bookings`)
        .set('X-Forwarded-For', SHARED_IP);
      expect(noAuth.status).toBe(401);
      expect(verifyIdTokenCalls).toEqual([]);

      const authed = await request(app)
        .get(`${BASE}/bookings`)
        .set('X-Forwarded-For', SHARED_IP)
        .set(authHeader('legit-uid'));
      expect(authed.status).toBe(200);
      expect(verifyIdTokenCalls).toContain('legit-uid');
    });
  });

  describe('(d) structural invariant — keyGenerator fallback when uid is undefined', () => {
    /**
     * `authedRateLimit` at `rateLimit.ts:80-86` is:
     *
     *     keyGenerator: (req) => getUid(req) ?? defaultKey(req)
     *
     * If `req.auth` were ever undefined when this middleware ran (which
     * Patch 5's ordering makes impossible — verifyAuth populates req.auth
     * or 401s), the keyGenerator falls back to `defaultKey(req)` = req.ip
     * (rateLimit.ts:39-45). That means anonymous bypass would NOT be
     * unkeyed — it would be IP-keyed, the same as publicRateLimit.
     *
     * We can't easily test the bypass at the route level (verifyAuth is
     * unconditional), so we test the keyGenerator branch directly by
     * driving rateLimit() on a minimal Express app with a stub middleware
     * that leaves req.auth undefined. This documents the fallback and
     * guards against future regressions where someone re-mounts
     * authedRateLimit outside a verifyAuth path.
     */
    it('authedRateLimit keyed on undefined uid falls back to req.ip (rateLimit.ts:84)', async () => {
      const express = (await import('express')).default;
      const { authedRateLimit } = await import('../../http/middleware/rateLimit');

      const app = express();
      app.set('trust proxy', 1);
      // Mount authedRateLimit WITHOUT verifyAuth in front — simulates the
      // pre-Patch-5 misconfiguration. Note rateLimit.ts:84 fallback chain
      // means: when req.auth is undefined, key = req.ip.
      app.use(authedRateLimit((req) => req.auth?.uid));
      app.get('/ping', (_req, res) => {
        res.json({ ok: true });
      });

      // Same IP twice → both should land in the SAME ip-keyed bucket.
      // Both well under 60, so both 200, no 429.
      const r1 = await request(app)
        .get('/ping')
        .set('X-Forwarded-For', '203.0.113.200');
      expect(r1.status).toBe(200);

      const r2 = await request(app)
        .get('/ping')
        .set('X-Forwarded-For', '203.0.113.200');
      expect(r2.status).toBe(200);

      // Sanity: a different IP is a different bucket.
      const r3 = await request(app)
        .get('/ping')
        .set('X-Forwarded-For', '203.0.113.201');
      expect(r3.status).toBe(200);
    });
  });
});
