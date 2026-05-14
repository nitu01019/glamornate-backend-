/**
 * Phase 4 Logic 4.3 (Booking Logic Round-2, 2026-05-08): edge-case coverage
 * for `istDateAtTimeToUtc` — the only timezone-translating call inside
 * `createBooking`. SC-1 / SC-9 require any user-perceived IST wall-clock
 * (leap day, year boundary, midnight, traveling customer) to map to a
 * deterministic UTC instant regardless of the process timezone.
 *
 * Mitigations referenced:
 *   - Phase 3.5 spec-logic-check-3 — IST is fixed UTC+05:30 (no DST).
 *   - Phase 3.5 spec-logic-check-7 — slot duration ≤ 180min in catalog
 *     so a slot can never reach 24:00 IST.
 *
 * The 24:00 case is included to PIN behavior: `date-fns-tz` collapses
 * '2027-06-15 24:00:00' to **same-day 00:00 IST** (not next-day rollover),
 * which is why the 180min cap is load-bearing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { istDateAtTimeToUtc } from '../utils/date-ist';

describe('istDateAtTimeToUtc — leap day', () => {
  it('Feb 29 on a leap year (2028) at 14:00 IST → 08:30 UTC same date', () => {
    const result = istDateAtTimeToUtc('2028-02-29', '14:00');
    expect(result.toISOString()).toBe('2028-02-29T08:30:00.000Z');
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  it('Feb 29 at 23:30 IST → 18:00 UTC same date', () => {
    const result = istDateAtTimeToUtc('2028-02-29', '23:30');
    expect(result.toISOString()).toBe('2028-02-29T18:00:00.000Z');
  });

  it('Feb 29 at 00:00 IST → 18:30 UTC the previous day (Feb 28)', () => {
    const result = istDateAtTimeToUtc('2028-02-29', '00:00');
    expect(result.toISOString()).toBe('2028-02-28T18:30:00.000Z');
  });
});

describe('istDateAtTimeToUtc — year boundary', () => {
  it('Dec 31 23:30 IST → 18:00 UTC same year', () => {
    const result = istDateAtTimeToUtc('2027-12-31', '23:30');
    expect(result.toISOString()).toBe('2027-12-31T18:00:00.000Z');
  });

  it('Jan 1 00:30 IST (next IST day) → 19:00 UTC on Dec 31 of previous year', () => {
    const result = istDateAtTimeToUtc('2028-01-01', '00:30');
    expect(result.toISOString()).toBe('2027-12-31T19:00:00.000Z');
  });

  it('Dec 31 23:30 IST precedes Jan 1 00:30 IST in absolute time', () => {
    const earlier = istDateAtTimeToUtc('2027-12-31', '23:30');
    const later = istDateAtTimeToUtc('2028-01-01', '00:30');
    expect(earlier.getTime()).toBeLessThan(later.getTime());
    // Exactly one IST hour apart.
    expect(later.getTime() - earlier.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('istDateAtTimeToUtc — midnight & 24:00 edge', () => {
  it('23:30 IST → 18:00 UTC same date (canonical late-evening slot)', () => {
    const result = istDateAtTimeToUtc('2027-06-15', '23:30');
    expect(result.toISOString()).toBe('2027-06-15T18:00:00.000Z');
  });

  it('23:59 IST → 18:29 UTC same date (last representable IST minute)', () => {
    const result = istDateAtTimeToUtc('2027-06-15', '23:59');
    expect(result.toISOString()).toBe('2027-06-15T18:29:00.000Z');
  });

  /**
   * Synthetic input: a 24:00 wall-clock string would only emerge if a slot
   * were synthesized with `start + duration` and duration pushed it past
   * midnight. The catalog max ≤ 180min mitigation prevents a real slot
   * from ever reaching 24:00 (worst case: 21:00 + 180min = 24:00, but the
   * end timestamp is computed from the UTC start instant + millis, never
   * by string concatenation — see createBooking).
   *
   * This test PINS the parser behaviour so a future maintainer relying
   * on string-arithmetic for slot end-times sees the unintuitive collapse.
   */
  it('24:00 IST collapses to same-day 00:00 IST (NOT next-day rollover)', () => {
    const result = istDateAtTimeToUtc('2027-06-15', '24:00');
    expect(Number.isNaN(result.getTime())).toBe(false);
    // 00:00 IST on 2027-06-15 → 18:30 UTC on 2027-06-14.
    expect(result.toISOString()).toBe('2027-06-14T18:30:00.000Z');

    const expectedNextDayMidnight = istDateAtTimeToUtc('2027-06-16', '00:00');
    // Documents the surprise: 24:00 does NOT equal next-day 00:00.
    expect(result.toISOString()).not.toBe(expectedNextDayMidnight.toISOString());
  });
});

describe('istDateAtTimeToUtc — traveling customer (process TZ)', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
    vi.unstubAllEnvs();
  });

  it('produces same UTC instant when process.env.TZ = America/Los_Angeles (PDT)', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const result = istDateAtTimeToUtc('2027-06-15', '14:00');
    expect(result.toISOString()).toBe('2027-06-15T08:30:00.000Z');
  });

  it('produces same UTC instant when process.env.TZ = UTC', () => {
    vi.stubEnv('TZ', 'UTC');
    const result = istDateAtTimeToUtc('2027-06-15', '14:00');
    expect(result.toISOString()).toBe('2027-06-15T08:30:00.000Z');
  });

  it('result is identical across PDT, UTC, and IST process timezones', () => {
    const date = '2027-06-15';
    const time = '14:00';

    vi.stubEnv('TZ', 'America/Los_Angeles');
    const pdt = istDateAtTimeToUtc(date, time).toISOString();

    vi.stubEnv('TZ', 'UTC');
    const utc = istDateAtTimeToUtc(date, time).toISOString();

    vi.stubEnv('TZ', 'Asia/Kolkata');
    const ist = istDateAtTimeToUtc(date, time).toISOString();

    expect(pdt).toBe(utc);
    expect(utc).toBe(ist);
    expect(ist).toBe('2027-06-15T08:30:00.000Z');
  });
});
