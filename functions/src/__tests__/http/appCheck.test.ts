/**
 * App Check middleware behaviour tests.
 *
 * When App Check is NOT bypassed, any request missing the
 * `X-Firebase-AppCheck` header must be rejected with 401.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '../../http/app';
import { resetRateLimitBuckets } from '../../http/middleware/rateLimit';

describe('App Check enforcement', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('rejects request without App Check token when enforcement is on', async () => {
    const app = buildApp({ disableAppCheck: false });

    const res = await request(app).get('/api/v1/services/categories');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/App Check/i);
  });

  it('allows health endpoint without App Check', async () => {
    const app = buildApp({ disableAppCheck: false });

    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });
});
