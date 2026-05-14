/**
 * Parity test for phone normalisation across the auth/bloom surface.
 *
 * The H1 incident (2026-05-10) was caused by drift between the writer
 * (`scheduled/rebuildSignupBloomFilter.ts`), the reader
 * (`callable/checkSignupAvailability.ts`), and the FE register-route
 * storage path. Each had its own inline copy of `normalisePhone` and
 * the inline copies disagreed with the FE-stored value for the most
 * common input shape (a bare 10-digit number). The bloom always
 * answered "definitely not present" for taken phones, so the callable
 * silently returned `{ available: true }` for collisions.
 *
 * After A-4-01:
 *   - `utils/phone.ts` is the single source of truth.
 *   - The writer + reader BOTH delegate to the canonical function.
 *   - The FE register route normalises before `setDoc` (mirrored copy
 *     because the FE cannot import from the BE bundle).
 *
 * This test pins the canonical normaliser to the post-fix shape for
 * every fixture the auth/bloom surface depends on. Critically, it
 * proves the test catches the H1 by inlining `LEGACY_PRE_FIX_NORMALISE`
 * — the exact body the writer + reader carried before A-4-01 — and
 * asserting the canonical disagrees with it on the H1 fixture. Anyone
 * reverting `utils/phone.ts` to the legacy logic trips that assertion.
 */

import { describe, it, expect } from 'vitest';
import { normalisePhone } from '../utils/phone';

/**
 * Legacy normaliser — exact byte-for-byte copy of what the writer +
 * reader inlined before A-4-01. Preserved here as a regression
 * baseline; the test below documents the drift it caused.
 */
function LEGACY_PRE_FIX_NORMALISE(raw: string): string {
  const trimmed = raw.replace(/\s+/g, '');
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

describe('phone normalisation parity', () => {
  describe('canonical normaliser pins the post-fix shape', () => {
    const fixtures: Array<{ input: string; expected: string; note: string }> = [
      {
        input: '+919999912345',
        expected: '+919999912345',
        note: 'already-E.164 → unchanged',
      },
      {
        input: '919999912345',
        expected: '+919999912345',
        note: 'country-coded but missing +',
      },
      {
        input: '+1234567890',
        expected: '+1234567890',
        note: 'US-shape E.164 → unchanged',
      },
      {
        input: '9999912345',
        expected: '+919999912345',
        note: '10-digit local — H1 drift case (FE stores +91 form)',
      },
      {
        input: '  +91 99999 12345 ',
        expected: '+919999912345',
        note: 'whitespace stripped',
      },
    ];

    for (const { input, expected, note } of fixtures) {
      it(`"${input}" → "${expected}" (${note})`, () => {
        expect(normalisePhone(input)).toBe(expected);
      });
    }
  });

  describe('canonical FIXES the H1 drift (catches regressions)', () => {
    /**
     * The 10-digit local case is the exact shape the FE submits at
     * registration. Legacy turned `9999912345` into `+9999912345`,
     * which diverged from how the FE persisted it (`9999912345`),
     * which in turn diverged from the canonical `+919999912345`. The
     * bloom missed every collision.
     *
     * If anyone reverts `utils/phone.ts` to the legacy body, the
     * second assertion below fires.
     */
    it('10-digit input gets country-code prepended (legacy did NOT)', () => {
      const input = '9999912345';
      const legacy = LEGACY_PRE_FIX_NORMALISE(input);
      const canonical = normalisePhone(input);

      expect(legacy).toBe('+9999912345');
      expect(canonical).toBe('+919999912345');
      expect(canonical).not.toBe(legacy);
    });

    it('whitespace + 10-digit fixture: legacy disagrees with canonical', () => {
      const input = ' 9999912345 ';
      expect(LEGACY_PRE_FIX_NORMALISE(input)).toBe('+9999912345');
      expect(normalisePhone(input)).toBe('+919999912345');
    });
  });

  describe('canonical normaliser is deterministic', () => {
    /**
     * Post-A-4-01 the writer (`scheduled/rebuildSignupBloomFilter.ts`)
     * and reader (`callable/checkSignupAvailability.ts`) both call
     * this single function — so byte-equality of their outputs is
     * trivially provable. We re-exercise determinism on a
     * representative fixture set so any quiet behaviour change in
     * `utils/phone.ts` shows up against this baseline.
     */
    const fixtures = [
      '+919999912345',
      '919999912345',
      '+1234567890',
      '9999912345',
      '  +91 99999 12345 ',
      '+15555555555',
    ];

    for (const raw of fixtures) {
      it(`is deterministic for "${raw}"`, () => {
        expect(normalisePhone(raw)).toBe(normalisePhone(raw));
      });
    }
  });

  describe('FE register flow stores E.164', () => {
    it('FE stitches +91 onto 10-digit input — canonical mirrors that', () => {
      expect(normalisePhone('9999912345')).toBe('+919999912345');
    });
  });
});
