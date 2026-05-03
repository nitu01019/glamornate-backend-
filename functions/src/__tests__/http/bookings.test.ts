/**
 * Unit tests for /bookings detail + list handlers.
 *
 * Mocks `firebase-admin` to avoid requiring Firestore credentials. The auth
 * middleware is also mocked so we can drive `req.auth.uid` directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockBookingDocGet = vi.fn();
const mockBookingsQueryGet = vi.fn();

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
    verifyIdToken: vi.fn(async (token: string) => {
      // Token encodes UID directly for simplicity in tests: `test:uid`
      const match = /^test:(.+)$/.exec(token);
      if (!match) throw new Error('bad token');
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

const app = buildApp({ disableAppCheck: true });
const BASE = '/api/v1';

function snap(id: string, data: Record<string, unknown>) {
  return { id, exists: true, data: () => data };
}

function authHeader(uid: string): Record<string, string> {
  return { Authorization: `Bearer test:${uid}` };
}

describe('/bookings/:id handler', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
    mockBookingDocGet.mockReset();
    mockBookingsQueryGet.mockReset();
  });

  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).get(`${BASE}/bookings/b-1`);
    expect(res.status).toBe(401);
  });

  it('returns 404 when booking is missing', async () => {
    mockBookingDocGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const res = await request(app).get(`${BASE}/bookings/b-1`).set(authHeader('u-1'));
    expect(res.status).toBe(404);
  });

  it('returns 200 when caller is the customer (userId match)', async () => {
    mockBookingDocGet.mockResolvedValueOnce(
      snap('b-1', { userId: 'u-1', spaOwnerId: 'u-99', bookingStatus: 'confirmed' }),
    );
    const res = await request(app).get(`${BASE}/bookings/b-1`).set(authHeader('u-1'));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('b-1');
  });

  it('returns 200 when caller is the spa owner', async () => {
    mockBookingDocGet.mockResolvedValueOnce(
      snap('b-1', { userId: 'u-1', spaOwnerId: 'u-99', bookingStatus: 'confirmed' }),
    );
    const res = await request(app).get(`${BASE}/bookings/b-1`).set(authHeader('u-99'));
    expect(res.status).toBe(200);
  });

  it('returns 403 (NOT 404) when cross-user access attempted', async () => {
    mockBookingDocGet.mockResolvedValueOnce(
      snap('b-1', { userId: 'u-1', spaOwnerId: 'u-99' }),
    );
    const res = await request(app)
      .get(`${BASE}/bookings/b-1`)
      .set(authHeader('u-evil'));
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('also accepts customerId alias', async () => {
    mockBookingDocGet.mockResolvedValueOnce(
      snap('b-1', { customerId: 'u-1', spaOwnerId: 'u-99' }),
    );
    const res = await request(app).get(`${BASE}/bookings/b-1`).set(authHeader('u-1'));
    expect(res.status).toBe(200);
  });
});

describe('/bookings list handler', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
    mockBookingDocGet.mockReset();
    mockBookingsQueryGet.mockReset();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get(`${BASE}/bookings`);
    expect(res.status).toBe(401);
  });

  it('returns bookings for caller with pagination meta', async () => {
    mockBookingsQueryGet.mockResolvedValueOnce({
      docs: [
        snap('b-1', { userId: 'u-1', createdAt: '2026-04-01' }),
        snap('b-2', { userId: 'u-1', createdAt: '2026-03-01' }),
      ],
    });

    const res = await request(app)
      .get(`${BASE}/bookings?limit=10`)
      .set(authHeader('u-1'));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.limit).toBe(10);
    expect(res.body.meta.offset).toBe(0);
  });
});
