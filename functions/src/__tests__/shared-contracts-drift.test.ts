import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drift guard: the FE and BE copies of shared/contracts/auth.ts MUST be
 * byte-identical. They are deliberately duplicated (workspace was dissolved
 * 2026-05-05) so this test is the only thing preventing silent drift of the
 * wire format — most critically the AuthErrorCode enum that both ends use
 * to map auth failures.
 *
 * If this test fails, copy one file over the other (whichever is correct)
 * and re-run.
 */
describe('shared/contracts/auth.ts drift guard', () => {
  it('FE and BE copies of shared/contracts/auth.ts are byte-identical', () => {
    const beFile = join(__dirname, '../shared/contracts/auth.ts');
    const feFile = join(
      __dirname,
      '../../../../frontend/src/shared/contracts/auth.ts',
    );

    const beHash = createHash('md5').update(readFileSync(beFile)).digest('hex');
    const feHash = createHash('md5').update(readFileSync(feFile)).digest('hex');

    expect(beHash).toBe(feHash);
  });
});
