/**
 * Phase 2 (Booking Flow Fix v3.1, 2026-05-02): backend mirror of the
 * frontend date-ist boundary tests. `istDateAtTimeToUtc` is the only
 * timezone-translating call inside `createBooking`, so a regression here
 * surfaces as Issue B (cannot book second same-day) again.
 */
import { describe, it, expect } from 'vitest';
import { istDateAtTimeToUtc, formatDateIST, todayIST } from '../date-ist';

describe('istDateAtTimeToUtc', () => {
  it('00:00 IST → 18:30 UTC previous day', () => {
    expect(istDateAtTimeToUtc('2026-05-02', '00:00').toISOString()).toBe(
      '2026-05-01T18:30:00.000Z',
    );
  });

  it('23:30 IST → 18:00 UTC same day', () => {
    expect(istDateAtTimeToUtc('2026-05-02', '23:30').toISOString()).toBe(
      '2026-05-02T18:00:00.000Z',
    );
  });

  it('14:00 IST → 08:30 UTC', () => {
    expect(istDateAtTimeToUtc('2026-05-02', '14:00').toISOString()).toBe(
      '2026-05-02T08:30:00.000Z',
    );
  });
});

describe('formatDateIST + todayIST', () => {
  it('formatDateIST yields the date component of an arbitrary IST instant', () => {
    const instant = new Date('2026-05-02T18:00:00.000Z'); // 23:30 IST
    expect(formatDateIST(instant)).toBe('2026-05-02');
  });

  it('todayIST is a string of shape YYYY-MM-DD', () => {
    expect(todayIST()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
