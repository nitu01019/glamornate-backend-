/**
 * CORS allowlist tests. The regex fallback must accept all localhost ports
 * and the static list must accept the production web domain + both
 * Capacitor WebView origins.
 */

import { describe, it, expect } from 'vitest';
import { isOriginAllowed, ALLOWED_ORIGINS } from '../../http/middleware/cors';

describe('CORS allowlist', () => {
  it('accepts production and Capacitor origins', () => {
    expect(isOriginAllowed('https://glamornate.vercel.app')).toBe(true);
    expect(isOriginAllowed('https://glamornate.com')).toBe(true);
    expect(isOriginAllowed('https://localhost')).toBe(true);
    expect(isOriginAllowed('capacitor://localhost')).toBe(true);
  });

  it('accepts any localhost port over http', () => {
    expect(isOriginAllowed('http://localhost')).toBe(true);
    expect(isOriginAllowed('http://localhost:3000')).toBe(true);
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
  });

  it('rejects other origins', () => {
    expect(isOriginAllowed('https://evil.com')).toBe(false);
    expect(isOriginAllowed('http://localhost.evil.com')).toBe(false);
    expect(isOriginAllowed('https://glamornate.vercel.app.evil.com')).toBe(false);
  });

  it('treats missing origin (server-to-server) as allowed', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
  });

  it('exposes the canonical allowlist array', () => {
    expect(ALLOWED_ORIGINS).toHaveLength(5);
  });
});
