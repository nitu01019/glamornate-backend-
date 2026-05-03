/**
 * HTTP route contract tests.
 *
 * Each suite fires a canonical request against the Express app and asserts:
 *   1. HTTP status matches expectation.
 *   2. Response body validates against the `@glamornate/contracts` zod schema.
 *
 * App Check is bypassed via `disableAppCheck: true` — emulator-grade only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import {
  CategoriesResponseSchema,
  MostBookedResponseSchema,
  ServicesListResponseSchema,
  ServiceDetailResponseSchema,
  PromotionsResponseSchema,
  SpasResponseSchema,
  SearchResponseSchema,
  TrendingResponseSchema,
  SuggestionResponseSchema,
} from '@glamornate/contracts';
import { buildApp } from '../../http/app';
import { resetRateLimitBuckets } from '../../http/middleware/rateLimit';

const app = buildApp({ disableAppCheck: true });
const BASE = '/api/v1';

describe('HTTP API — contract tests', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe('ok');
  });

  it('GET /services/categories matches contract', async () => {
    const res = await request(app).get(`${BASE}/services/categories`);
    expect(res.status).toBe(200);
    const parsed = CategoriesResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /services/most-booked matches contract and respects limit', async () => {
    const res = await request(app).get(`${BASE}/services/most-booked?limit=5`);
    expect(res.status).toBe(200);
    const parsed = MostBookedResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(5);
  });

  it('GET /services paginates correctly', async () => {
    const res = await request(app).get(`${BASE}/services?limit=3&offset=0`);
    expect(res.status).toBe(200);
    const parsed = ServicesListResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.meta?.total).toBeGreaterThanOrEqual(res.body.data.length);
  });

  it('GET /services/:id returns 404 for unknown id', async () => {
    const res = await request(app).get(`${BASE}/services/__not_a_real_service__`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('GET /services/:id returns a service when it exists', async () => {
    // Find a real service id via the list endpoint first.
    const list = await request(app).get(`${BASE}/services?limit=1`);
    const first = list.body.data?.[0];
    expect(first?.id).toBeTruthy();

    const res = await request(app).get(`${BASE}/services/${first.id}`);
    expect(res.status).toBe(200);
    const parsed = ServiceDetailResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
  });

  it('GET /promotions matches contract', async () => {
    const res = await request(app).get(`${BASE}/promotions`);
    expect(res.status).toBe(200);
    const parsed = PromotionsResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
  });

  it('GET /spas returns list matching contract', async () => {
    const res = await request(app).get(`${BASE}/spas?limit=10`);
    // Without Firebase credentials, Firestore call either succeeds (emulator)
    // or returns 500 due to ADC failure. We test contract for both paths so
    // the test runs in a CI environment without ADC.
    if (res.status === 200) {
      const parsed = SpasResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(Array.isArray(res.body.data.spas)).toBe(true);
    } else {
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    }
  });

  it('GET /spas/:id returns 404 for unknown id', async () => {
    const res = await request(app).get(`${BASE}/spas/__definitely_not_a_real_spa__`);
    // Emulator path: 404. No-ADC path: 500. Either way the auth boundary is
    // not crossed and the envelope is consistent.
    expect([404, 500]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  it('GET /search returns scored results for a non-trivial query', async () => {
    const res = await request(app).get(`${BASE}/search?q=facial&limit=5`);
    expect(res.status).toBe(200);
    const parsed = SearchResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /search/trending matches contract', async () => {
    const res = await request(app).get(`${BASE}/search/trending`);
    expect(res.status).toBe(200);
    const parsed = TrendingResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    // bookingCount must be stripped from public payload
    for (const item of res.body.data) {
      expect(item).not.toHaveProperty('bookingCount');
    }
  });

  it('GET /search/suggestions returns at most 8 suggestions', async () => {
    const res = await request(app).get(`${BASE}/search/suggestions?q=fac`);
    expect(res.status).toBe(200);
    const parsed = SuggestionResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(8);
  });

  it('GET /search/suggestions returns empty for short query', async () => {
    const res = await request(app).get(`${BASE}/search/suggestions?q=a`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('POST /bookings without auth returns 401', async () => {
    const res = await request(app)
      .post(`${BASE}/bookings`)
      .send({ services: [{ serviceId: 'x', quantity: 1 }], date: '2026-05-01', timeSlot: '10:00', location: 'spa' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('GET /bookings/:id without auth returns 401', async () => {
    const res = await request(app).get(`${BASE}/bookings/some-id`);
    expect(res.status).toBe(401);
  });

  it('returns 404 envelope for unknown path', async () => {
    const res = await request(app).get(`${BASE}/no-such-route-exists`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('HTTP API — rate limiting', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('returns 429 after crossing the public limit', async () => {
    const freshApp = buildApp({ disableAppCheck: true });

    // 20 requests pass, the 21st gets limited.
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const res = await request(freshApp)
        .get(`${BASE}/search/trending`)
        .set('X-Forwarded-For', '203.0.113.1');
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
