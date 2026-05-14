/**
 * Unit tests for the BloomFilter implementation in `utils/bloom-filter.ts`.
 *
 * Coverage targets:
 *   - round-trip add/has correctness (no false negatives ever)
 *   - false-positive rate within tolerance for 10k items at default params
 *   - deterministic hashing given a fixed salt (writer/reader agree)
 *   - serialise → deserialise round-trip preserves membership
 *   - computeBitSize formula correctness
 *   - edge cases: empty filter, k=7 hash distribution sanity
 */

import { describe, it, expect } from 'vitest';
import {
  BloomFilter,
  DEFAULT_FPR,
  DEFAULT_HASH_COUNT,
  DEFAULT_SALT,
  computeBitSize,
} from '../utils/bloom-filter';

describe('computeBitSize', () => {
  it('returns the minimum 8 bits for non-positive inputs', () => {
    expect(computeBitSize(0)).toBe(8);
    expect(computeBitSize(-100)).toBe(8);
  });

  it('rounds up to the nearest byte boundary', () => {
    // For any positive expectedItems, output must be divisible by 8.
    for (const n of [1, 7, 100, 1000, 10_000]) {
      expect(computeBitSize(n) % 8).toBe(0);
    }
  });

  it('matches the classic Bloom formula for n=10_000 fpr=0.01', () => {
    // m = ceil(- (n * ln(p)) / (ln(2)^2))
    //   = ceil(- (10000 * ln(0.01)) / (ln(2)^2))
    //   = ceil(- (10000 * -4.60517) / 0.48045)
    //   = ceil(95850.58)
    //   = 95851 → rounded up to 95856 (next multiple of 8)
    const m = computeBitSize(10_000, 0.01);
    expect(m).toBe(95856);
  });

  it('grows monotonically with expected items', () => {
    expect(computeBitSize(100, 0.01)).toBeLessThan(computeBitSize(1000, 0.01));
    expect(computeBitSize(1000, 0.01)).toBeLessThan(computeBitSize(10_000, 0.01));
  });

  it('grows as the FPR target tightens', () => {
    expect(computeBitSize(1000, 0.1)).toBeLessThan(computeBitSize(1000, 0.01));
    expect(computeBitSize(1000, 0.01)).toBeLessThan(computeBitSize(1000, 0.001));
  });
});

describe('BloomFilter — round-trip', () => {
  it('reports has() true for every value previously added (no false negatives)', () => {
    const filter = BloomFilter.create(1000);
    const values = ['alice@example.com', 'bob@example.com', '+919999912345', '+15555555555'];
    for (const v of values) filter.add(v);
    for (const v of values) {
      expect(filter.has(v)).toBe(true);
    }
  });

  it('add() is idempotent — repeated adds do not corrupt membership', () => {
    const filter = BloomFilter.create(100);
    filter.add('x');
    filter.add('x');
    filter.add('x');
    expect(filter.has('x')).toBe(true);
  });

  it('an empty filter reports has() false for every probe (no spurious hits on a zero buffer)', () => {
    const filter = BloomFilter.create(1000);
    for (const v of ['a', 'b', 'c', '@', 'never-added']) {
      expect(filter.has(v)).toBe(false);
    }
  });
});

describe('BloomFilter — false-positive rate', () => {
  it('FPR for 10k items at default params stays within ~3x of the target 1%', () => {
    // We're not running the full 1k-trial Monte Carlo here because vitest
    // wants fast tests. A 10k-add / 10k-probe pass is enough to catch
    // gross misconfig (FPR ≫ 5%) while staying under 100ms.
    const filter = BloomFilter.create(10_000);
    for (let i = 0; i < 10_000; i++) {
      filter.add(`user-${i}@example.com`);
    }
    let falsePositives = 0;
    const PROBES = 10_000;
    for (let i = 0; i < PROBES; i++) {
      // Probe values that were NOT added.
      if (filter.has(`outsider-${i}@example.com`)) {
        falsePositives++;
      }
    }
    const fpr = falsePositives / PROBES;
    // Target is 1%; allow up to 3% headroom for the tail of the distribution.
    expect(fpr).toBeLessThan(0.03);
  });
});

describe('BloomFilter — deterministic hashing', () => {
  it('two filters with the same salt produce identical bit positions for a value', () => {
    const a = BloomFilter.create(100, { salt: 'fixed-salt' });
    const b = BloomFilter.create(100, { salt: 'fixed-salt' });
    a.add('alice@example.com');
    b.add('alice@example.com');
    // Same salt → same hash → bit-identical buffers for the same input set.
    expect(a.serialise().buffer).toBe(b.serialise().buffer);
  });

  it('different salts produce different bit positions for the same value', () => {
    const a = BloomFilter.create(100, { salt: 'salt-a' });
    const b = BloomFilter.create(100, { salt: 'salt-b' });
    a.add('alice@example.com');
    b.add('alice@example.com');
    expect(a.serialise().buffer).not.toBe(b.serialise().buffer);
  });
});

describe('BloomFilter — serialise / deserialise round-trip', () => {
  it('rehydrates a filter and preserves membership', () => {
    const filter = BloomFilter.create(1000);
    const values = ['x@y.com', '+919999912345', 'foo'];
    for (const v of values) filter.add(v);

    const payload = filter.serialise();
    const restored = BloomFilter.deserialise(payload);

    for (const v of values) {
      expect(restored.has(v)).toBe(true);
    }
    expect(restored.has('not-added')).toBe(false);
  });

  it('serialised payload exposes the canonical params for the read path', () => {
    const filter = BloomFilter.create(1000);
    const payload = filter.serialise();
    expect(payload.hashCount).toBe(DEFAULT_HASH_COUNT);
    expect(payload.salt).toBe(DEFAULT_SALT);
    expect(payload.bits % 8).toBe(0);
    expect(typeof payload.buffer).toBe('string');
  });

  it('throws on a tampered payload whose buffer length disagrees with bits', () => {
    const filter = BloomFilter.create(1000);
    const payload = filter.serialise();
    const tampered = {
      ...payload,
      // Re-encode a buffer one byte shorter than `bits` requires.
      buffer: Buffer.from(new Uint8Array(Math.ceil(payload.bits / 8) - 1)).toString('base64'),
    };
    expect(() => BloomFilter.deserialise(tampered)).toThrow(/buffer length/);
  });
});

describe('BloomFilter — k=7 hash distribution sanity', () => {
  it('sets k distinct positions on a single add() (typical case)', () => {
    // Build a filter and add a single value. The number of set bits MUST
    // be at most `hashCount` (k). Because of the modulo collapse on small
    // bit arrays, two of the k positions could collide; we test on a
    // generously-sized filter where the probability of internal
    // collision is negligible.
    const filter = BloomFilter.create(10_000);
    filter.add('alice@example.com');
    const buf = Buffer.from(filter.serialise().buffer, 'base64');
    let setBits = 0;
    for (const byte of buf) {
      // Brian Kernighan's bit-count trick.
      let b = byte;
      while (b) {
        setBits += b & 1;
        b >>>= 1;
      }
    }
    // For k=7 hash functions and ~96 kbit array, expected setBits is ≈7
    // (collisions are rare). Allow 1..7 to permit the rare collapse.
    expect(setBits).toBeGreaterThanOrEqual(1);
    expect(setBits).toBeLessThanOrEqual(DEFAULT_HASH_COUNT);
  });
});

describe('BloomFilter.create — defaults', () => {
  it('honours the default FPR + hashCount + salt unless overridden', () => {
    const filter = BloomFilter.create(1000);
    const params = filter.getParams();
    expect(params.hashCount).toBe(DEFAULT_HASH_COUNT);
    expect(params.salt).toBe(DEFAULT_SALT);
    expect(params.bits).toBe(computeBitSize(1000, DEFAULT_FPR));
  });

  it('respects a per-call override', () => {
    const filter = BloomFilter.create(100, { salt: 'custom', hashCount: 3 });
    const params = filter.getParams();
    expect(params.salt).toBe('custom');
    expect(params.hashCount).toBe(3);
  });
});
