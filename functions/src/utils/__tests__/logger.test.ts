/**
 * Tests for the SEC-M4 PII log scrubber. The Logger class itself is mostly
 * a thin wrapper over firebase-functions/logger, so we focus on scrubPII's
 * redaction behaviour — the hard-to-get-right part — rather than the
 * forwarding plumbing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-functions BEFORE importing logger so the logger imports
// our inert stub and we can assert on the forwarded payload without
// writing to real GCP logging. vi.hoisted() is required because vi.mock
// is hoisted to the top of the file.
const { mockLoggerFns } = vi.hoisted(() => ({
  mockLoggerFns: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('firebase-functions', () => ({
  default: {},
  logger: mockLoggerFns,
}));

import { createLogger, scrubPII } from '../logger';

describe('scrubPII (SEC-M4)', () => {
  it('returns undefined when given undefined', () => {
    expect(scrubPII(undefined)).toBeUndefined();
  });

  it('redacts top-level email', () => {
    expect(scrubPII({ email: 'alice@example.com' })).toEqual({
      email: '[REDACTED]',
    });
  });

  it('redacts mixed PII keys case-insensitively', () => {
    const input = {
      EMAIL: 'a@b.com',
      Phone: '+15551234',
      CARD_last4: '4242',
      access_token: 'tkn',
      SecRetKey: 's',
      password: 'p',
      OTP: '123456',
      SSN: '000',
      Aadhar: '111',
      userId: 'user-1',
    };
    expect(scrubPII(input)).toEqual({
      EMAIL: '[REDACTED]',
      Phone: '[REDACTED]',
      CARD_last4: '[REDACTED]',
      access_token: '[REDACTED]',
      SecRetKey: '[REDACTED]',
      password: '[REDACTED]',
      OTP: '[REDACTED]',
      SSN: '[REDACTED]',
      Aadhar: '[REDACTED]',
      userId: 'user-1',
    });
  });

  it('recursively scrubs nested objects', () => {
    const input = {
      user: {
        id: 'u1',
        email: 'x@y.com',
        contact: { phone: '555' },
      },
      meta: { ok: true },
    };
    expect(scrubPII(input)).toEqual({
      user: {
        id: 'u1',
        email: '[REDACTED]',
        contact: { phone: '[REDACTED]' },
      },
      meta: { ok: true },
    });
  });

  it('leaves arrays untouched (does not descend)', () => {
    const input = { ids: ['1', '2', '3'], email: 'a@b.com' };
    expect(scrubPII(input)).toEqual({
      ids: ['1', '2', '3'],
      email: '[REDACTED]',
    });
  });

  it('does not mutate the input object', () => {
    const input = { email: 'a@b.com', n: 1 };
    const copy = { ...input };
    scrubPII(input);
    expect(input).toEqual(copy);
  });

  it('preserves primitives and non-PII fields verbatim', () => {
    const input = { count: 42, enabled: true, name: 'abc' };
    expect(scrubPII(input)).toEqual(input);
  });
});

describe('Logger entry points apply scrubbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('info() redacts PII keys before forwarding', () => {
    const log = createLogger('test-ctx');
    log.info('hi', { email: 'alice@example.com', userId: 'u1' });

    expect(mockLoggerFns.info).toHaveBeenCalledTimes(1);
    const [payload] = mockLoggerFns.info.mock.calls[0];
    expect(payload.email).toBe('[REDACTED]');
    expect(payload.userId).toBe('u1');
    expect(payload.context).toBe('test-ctx');
    expect(payload.message).toBe('hi');
  });

  it('warn() redacts PII keys before forwarding', () => {
    const log = createLogger('test');
    log.warn('careful', { phone: '+15550000', status: 'ok' });

    const [payload] = mockLoggerFns.warn.mock.calls[0];
    expect(payload.phone).toBe('[REDACTED]');
    expect(payload.status).toBe('ok');
  });

  it('error() redacts PII keys from structured payloads', () => {
    const log = createLogger('test');
    log.error('boom', { token: 'abc', note: 'details' });

    const [payload] = mockLoggerFns.error.mock.calls[0];
    expect(payload.token).toBe('[REDACTED]');
    expect(payload.note).toBe('details');
  });

  it('error() with an Error instance still redacts any PII-keyed fields', () => {
    const log = createLogger('test');
    const err = new Error('bad');
    // Logger.coerceData returns { name, message, stack } — none of those are
    // PII-named, so they should pass through untouched.
    log.error('oh no', err);

    const [payload] = mockLoggerFns.error.mock.calls[0];
    expect(payload.name).toBe('Error');
    expect(payload.message).toBe('bad');
  });
});
