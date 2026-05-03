/**
 * Unit tests for /spas list + detail handlers.
 *
 * `firebase-admin` is mocked so the tests do not require Firestore creds.
 * We hand-roll a thin query builder stub that records the chained calls and
 * returns a canned snapshot for the final `.get()`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mock firebase-admin BEFORE importing app — vitest hoists vi.mock to top of file.
// ---------------------------------------------------------------------------
const mockGet = vi.fn();
const mockServicesGet = vi.fn();
const mockSpaDocGet = vi.fn();

type QueryChain = {
  where: (...args: unknown[]) => QueryChain;
  orderBy: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
  startAfter: (...args: unknown[]) => QueryChain;
  offset: (...args: unknown[]) => QueryChain;
  get: () => Promise<unknown>;
};

function makeQueryChain(getImpl: () => Promise<unknown>): QueryChain {
  const chain: QueryChain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    startAfter: vi.fn(() => chain),
    offset: vi.fn(() => chain),
    get: getImpl,
  };
  return chain;
}

vi.mock('firebase-admin', () => {
  const firestoreFn = () => ({
    collection: vi.fn((name: string) => {
      if (name === 'spas') {
        return {
          ...makeQueryChain(() => mockGet()),
          doc: vi.fn(() => ({
            get: () => mockSpaDocGet(),
            collection: vi.fn(() => ({
              ...makeQueryChain(() => mockServicesGet()),
            })),
          })),
        };
      }
      return makeQueryChain(() => Promise.resolve({ docs: [] }));
    }),
  });
  return {
    default: { initializeApp: vi.fn(), firestore: firestoreFn, appCheck: () => ({}), auth: () => ({}) },
    initializeApp: vi.fn(),
    firestore: firestoreFn,
    appCheck: () => ({}),
    auth: () => ({}),
  };
});

// Lazy-import app after the mock registers.
import { buildApp } from '../../http/app';
import { resetRateLimitBuckets } from '../../http/middleware/rateLimit';

const app = buildApp({ disableAppCheck: true });
const BASE = '/api/v1';

function snap(id: string, data: Record<string, unknown>) {
  return {
    id,
    exists: true,
    data: () => data,
  };
}

describe('/spas handlers', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
    mockGet.mockReset();
    mockServicesGet.mockReset();
    mockSpaDocGet.mockReset();
  });

  it('GET /spas returns spas with pagination envelope', async () => {
    mockGet.mockResolvedValueOnce({
      docs: [
        snap('spa-1', { name: 'Spa One', city: 'pune', featuredRank: 1 }),
        snap('spa-2', { name: 'Spa Two', city: 'pune', featuredRank: 2 }),
      ],
    });

    const res = await request(app).get(`${BASE}/spas?limit=5&city=pune`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.spas).toHaveLength(2);
    expect(res.body.data.spas[0].id).toBe('spa-1');
    expect(res.body.data.pagination.hasMore).toBe(false);
    expect(res.body.data.filters.city).toBe('pune');
  });

  it('GET /spas computes hasMore when extra doc returned', async () => {
    mockGet.mockResolvedValueOnce({
      docs: [
        snap('spa-1', { name: 'A' }),
        snap('spa-2', { name: 'B' }),
        snap('spa-3', { name: 'C' }), // limit=2 → 3rd doc triggers hasMore
      ],
    });

    const res = await request(app).get(`${BASE}/spas?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.data.spas).toHaveLength(2);
    expect(res.body.data.pagination.hasMore).toBe(true);
    expect(res.body.data.pagination.nextCursor).toBe('spa-2');
  });

  it('GET /spas/:id returns 404 when not found', async () => {
    mockSpaDocGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    mockServicesGet.mockResolvedValueOnce({ docs: [] });

    const res = await request(app).get(`${BASE}/spas/ghost`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('GET /spas/:id returns merged spa + services', async () => {
    mockSpaDocGet.mockResolvedValueOnce(
      snap('spa-1', { name: 'Serenity', city: 'pune' }),
    );
    mockServicesGet.mockResolvedValueOnce({
      docs: [snap('svc-1', { name: 'Facial', basePrice: 999 })],
    });

    const res = await request(app).get(`${BASE}/spas/spa-1`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('spa-1');
    expect(res.body.data.services).toHaveLength(1);
    expect(res.body.data.services[0].id).toBe('svc-1');
  });
});
