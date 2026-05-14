/**
 * Bloom filter — Phase 7 signup-availability optimisation.
 *
 * A bloom filter is a probabilistic membership-test data structure: it can
 * report "definitely not present" with no false negatives, and "maybe
 * present" with a small false-positive rate (~1% by default here).
 *
 * Strategy:
 *   - Pure JS, no external dep. We avoid `bloomfilter` / `bloom-filters`
 *     npm packages to keep the function bundle slim.
 *   - Hash via SHA-256 of `(salt + value)`, then derive 7 distinct bit
 *     positions through the double-hashing trick (h_i = h1 + i * h2 mod m).
 *   - Bit array packed into a `Uint8Array` for compact (de)serialisation
 *     to base64 — small enough to fit comfortably in a Firestore field.
 *
 * Sizing (1% FPR, k=7, n=current users count):
 *   - m = ceil(- (n * ln(p)) / (ln(2)^2)) ≈ 9.585 * n  →  rounded to 10n.
 *   - For n=10_000 users that's ~12.5 KB raw / ~16.7 KB base64 — fine.
 *
 * Used by:
 *   - `scheduled/rebuildSignupBloomFilter.ts` to populate two filters
 *     (email + phone) every day at 03:00 IST and persist them at
 *     `_meta/signupBloom`.
 *   - `callable/checkSignupAvailability.ts` to short-circuit obviously-free
 *     emails/phones without doing a Firestore equality query — the
 *     authoritative query is reserved for the "maybe present" cases.
 *
 * Security note (H4):
 *   The persisted bloom doc at `_meta/signupBloom` is admin-only —
 *   `allow read: if false; allow write: if false;` per `firestore.rules`.
 *   Even authenticated reads are denied because the raw bit buffer is a
 *   bulk-probable enumeration oracle (an attacker could fetch it once
 *   and compute membership offline against millions of candidate
 *   emails — ~1% FPR is not enough to make that safe). The signup form
 *   must always go through the `checkSignupAvailability` callable,
 *   which uses the Admin SDK and bypasses rules; the frontend MUST
 *   NEVER read the bloom doc directly.
 */

import { createHash } from 'crypto';

/** Default false-positive rate (1%). */
export const DEFAULT_FPR = 0.01;
/** Default number of hash functions; matches DEFAULT_FPR for k = -log2(p). */
export const DEFAULT_HASH_COUNT = 7;
/** Default fixed salt — deterministic hashing across rebuilds. */
export const DEFAULT_SALT = 'glamornate.signup.bloom.v1';

/**
 * Snapshot of the bloom filter's tunable parameters. Persisted alongside
 * the bit array so the deserialiser can reconstruct an exactly-shaped
 * filter without out-of-band knowledge.
 */
export interface BloomFilterParams {
  /** Bit array length (m). */
  bits: number;
  /** Number of hash functions (k). */
  hashCount: number;
  /** Salt used to namespace this filter. */
  salt: string;
}

/**
 * Wire shape of a serialised bloom filter — base64-encoded bit buffer
 * plus the parameters needed to re-instantiate it on the read side.
 */
export interface BloomFilterPayload extends BloomFilterParams {
  /** Base64-encoded `Uint8Array` of length `ceil(bits / 8)`. */
  buffer: string;
}

/**
 * Compute the optimal `m` (bit array size) for a target false-positive rate
 * and expected element count. Uses the classic Bloom formula and rounds up
 * to the nearest byte boundary so the packed buffer length is integral.
 */
export function computeBitSize(expectedItems: number, fpr: number = DEFAULT_FPR): number {
  if (expectedItems <= 0) return 8; // minimum 1 byte to avoid div-by-zero
  const ln2sq = Math.LN2 * Math.LN2;
  const raw = Math.ceil((-expectedItems * Math.log(fpr)) / ln2sq);
  // Round up to the nearest 8 so `Uint8Array` packing has no slack bits.
  return Math.max(8, Math.ceil(raw / 8) * 8);
}

/**
 * Bloom filter implementation backed by a packed `Uint8Array`.
 *
 * Construct via {@link BloomFilter.create} for a fresh filter, or
 * {@link BloomFilter.deserialise} to rehydrate from base64.
 */
export class BloomFilter {
  private readonly buffer: Uint8Array;
  private readonly bits: number;
  private readonly hashCount: number;
  private readonly salt: string;

  private constructor(buffer: Uint8Array, params: BloomFilterParams) {
    this.buffer = buffer;
    this.bits = params.bits;
    this.hashCount = params.hashCount;
    this.salt = params.salt;
  }

  /**
   * Build a fresh empty filter sized for `expectedItems`. Defaults to 1%
   * FPR and 7 hash functions.
   */
  static create(
    expectedItems: number,
    opts: Partial<BloomFilterParams> & { fpr?: number } = {},
  ): BloomFilter {
    const bits = opts.bits ?? computeBitSize(expectedItems, opts.fpr ?? DEFAULT_FPR);
    const hashCount = opts.hashCount ?? DEFAULT_HASH_COUNT;
    const salt = opts.salt ?? DEFAULT_SALT;
    const byteLen = Math.ceil(bits / 8);
    return new BloomFilter(new Uint8Array(byteLen), { bits, hashCount, salt });
  }

  /**
   * Reconstruct a filter previously written by {@link BloomFilter.serialise}.
   * Throws if the embedded params are inconsistent with the buffer length.
   */
  static deserialise(payload: BloomFilterPayload): BloomFilter {
    const buffer = Uint8Array.from(Buffer.from(payload.buffer, 'base64'));
    const expectedBytes = Math.ceil(payload.bits / 8);
    if (buffer.length !== expectedBytes) {
      throw new Error(
        `BloomFilter deserialise: buffer length ${buffer.length} != ceil(bits/8)=${expectedBytes}`,
      );
    }
    return new BloomFilter(buffer, {
      bits: payload.bits,
      hashCount: payload.hashCount,
      salt: payload.salt,
    });
  }

  /** Add a value to the filter. Idempotent; safe to call repeatedly. */
  add(value: string): void {
    for (const idx of this.positions(value)) {
      const byte = idx >>> 3;
      const bit = idx & 7;
      this.buffer[byte] |= 1 << bit;
    }
  }

  /**
   * Probe membership.
   *  - `false`  → definitely not present (no false negatives).
   *  - `true`   → maybe present (≈FPR chance of being a false positive).
   */
  has(value: string): boolean {
    for (const idx of this.positions(value)) {
      const byte = idx >>> 3;
      const bit = idx & 7;
      if ((this.buffer[byte] & (1 << bit)) === 0) {
        return false;
      }
    }
    return true;
  }

  /** Snapshot the filter to a serialisable payload (base64-packed). */
  serialise(): BloomFilterPayload {
    return {
      buffer: Buffer.from(this.buffer).toString('base64'),
      bits: this.bits,
      hashCount: this.hashCount,
      salt: this.salt,
    };
  }

  /** Expose the params (read-only) for diagnostics + tests. */
  getParams(): BloomFilterParams {
    return { bits: this.bits, hashCount: this.hashCount, salt: this.salt };
  }

  /**
   * Compute the `k` bit positions for a value via double-hashing.
   *
   * SHA-256 of `salt:value` produces 32 bytes; we split it into two 32-bit
   * unsigned ints (h1, h2) and derive each position as
   * `(h1 + i * h2) mod m`. This is the standard Bloom double-hashing
   * technique — cheaper than `k` independent hashes, with no measurable
   * FPR penalty for `k <= 32`.
   */
  private *positions(value: string): Generator<number, void, void> {
    const digest = createHash('sha256').update(`${this.salt}:${value}`).digest();
    const h1 = digest.readUInt32BE(0);
    const h2 = digest.readUInt32BE(4);
    for (let i = 0; i < this.hashCount; i++) {
      // Use unsigned arithmetic — `>>> 0` keeps it within Number's safe
      // 32-bit range so `% bits` is well-defined for all positive `bits`.
      const combined = (h1 + Math.imul(i, h2)) >>> 0;
      yield combined % this.bits;
    }
  }
}
