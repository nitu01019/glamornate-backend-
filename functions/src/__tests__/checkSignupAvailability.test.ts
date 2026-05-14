/**
 * Tests for the `checkSignupAvailability` callable.
 *
 * Covers:
 *   - cold-start (no `_meta/signupBloom` doc) — falls through to the
 *     authoritative Firestore query.
 *   - warm bloom hit (maybe-present) → `fieldIsTaken` is invoked and the
 *     authoritative result is propagated.
 *   - warm bloom miss (definitely-not-present) → Firestore lookup is
 *     skipped and the field is reported `available: true`.
 *   - per-app rate-limit slot → returns empty `{}` (silent throttle).
 *   - schema validation rejects payloads that omit both fields.
 *   - App Check appId fallback ('unknown') is exercised when `req.app`
 *     is absent. App Check ENFORCEMENT itself is gated by the onCall
 *     `enforceAppCheck: true` option — outside the handler under test —
 *     so we test the option is set rather than the rejection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — lifted state for mocks
// ---------------------------------------------------------------------------

const {
  mockBloomLoad,
  mockBloomEmail,
  mockBloomPhone,
  mockUsersWhereGet,
  mockRateLimitTransaction,
  mockOnCallOpts,
  capturedOnCallHandler,
} = vi.hoisted(() => ({
  mockBloomLoad: vi.fn(),
  mockBloomEmail: { has: vi.fn() },
  mockBloomPhone: { has: vi.fn() },
  mockUsersWhereGet: vi.fn(),
  mockRateLimitTransaction: vi.fn(),
  mockOnCallOpts: { current: undefined as unknown },
  capturedOnCallHandler: { current: undefined as unknown },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = vi.fn().mockImplementation((name: string) => {
    if (name === '_meta') {
      return {
        doc: () => ({
          get: () => mockBloomLoad(),
        }),
      };
    }
    if (name === '_rateLimits') {
      return {
        doc: () => ({}),
      };
    }
    if (name === 'users') {
      return {
        where: () => ({
          limit: () => ({
            get: () => mockUsersWhereGet(),
          }),
        }),
      };
    }
    return { doc: () => ({ get: () => ({ exists: false }) }) };
  });

  const firestoreInstance = {
    collection,
    runTransaction: (fn: (tx: unknown) => unknown) => mockRateLimitTransaction(fn),
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  };
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _increment: n }),
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  };

  return {
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
  };
});

vi.mock('firebase-functions', () => {
  class HttpsError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.name = 'HttpsError';
      this.code = code;
      this.details = details;
    }
  }
  return {
    default: {
      https: { HttpsError },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    https: { HttpsError },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('firebase-functions/v2/https', () => ({
  onCall: (opts: unknown, handler: unknown) => {
    mockOnCallOpts.current = opts;
    capturedOnCallHandler.current = handler;
    return handler;
  },
}));

vi.mock('../utils/bloom-filter', async () => {
  const real = await vi.importActual<typeof import('../utils/bloom-filter')>(
    '../utils/bloom-filter',
  );
  return {
    ...real,
    BloomFilter: {
      ...real.BloomFilter,
      deserialise: (payload: { kind: 'email' | 'phone' } & Record<string, unknown>) => {
        // We map the stub payload kind to one of the two pre-constructed
        // bloom mocks so each test can drive `has()` independently.
        if (payload.kind === 'email') return mockBloomEmail;
        return mockBloomPhone;
      },
    },
  };
});

vi.mock('../utils/withRateLimit', () => ({
  // Identity wrapper — we test the inner business logic directly.
  withRateLimit: (
    _opts: unknown,
    fn: (data: unknown, ctx: unknown) => Promise<unknown>,
  ) => fn,
}));

vi.mock('../utils/error-handler', () => ({
  handleError: (err: unknown) => err,
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER mocks)
// ---------------------------------------------------------------------------

let checkSignupAvailability: (req: unknown) => Promise<unknown>;

beforeEach(async () => {
  vi.clearAllMocks();
  // Default rate-limit transaction: allow.
  mockRateLimitTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    // Transaction body uses tx.get/tx.set/tx.update — give a stub that
    // always returns "no doc" so it falls into the new-window branch.
    const tx = {
      get: async () => ({ exists: false, data: () => undefined }),
      set: vi.fn(),
      update: vi.fn(),
    };
    return fn(tx);
  });

  // Fresh module so onCall is captured anew each test.
  vi.resetModules();
  const mod = await import('../callable/checkSignupAvailability');
  checkSignupAvailability = mod.checkSignupAvailability as unknown as (
    req: unknown,
  ) => Promise<unknown>;
});

const reqWithEmail = (email: string, appId = 'app-123') => ({
  data: { email },
  app: { appId, alreadyConsumed: false },
  rawRequest: {
    headers: { 'x-forwarded-for': '203.0.113.1' },
    ip: '203.0.113.1',
  },
});

const reqWithPhone = (phone: string, appId = 'app-123') => ({
  data: { phone },
  app: { appId, alreadyConsumed: false },
  rawRequest: {
    headers: { 'x-forwarded-for': '203.0.113.1' },
    ip: '203.0.113.1',
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkSignupAvailability — onCall configuration', () => {
  it('opts pin enforceAppCheck=true and CORS=true', () => {
    expect(mockOnCallOpts.current).toMatchObject({
      enforceAppCheck: true,
      cors: true,
      region: 'us-central1',
    });
  });
});

describe('checkSignupAvailability — cold start', () => {
  beforeEach(() => {
    // No _meta/signupBloom doc yet.
    mockBloomLoad.mockResolvedValue({ exists: false });
  });

  it('with no bloom doc, treats every probe as "maybe present" and falls through to Firestore', async () => {
    // Authoritative says NOT taken.
    mockUsersWhereGet.mockResolvedValue({ empty: true });

    const result = await checkSignupAvailability(reqWithEmail('alice@example.com'));

    expect(mockUsersWhereGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ email: { available: true } });
  });

  it('with no bloom doc and Firestore reporting collision, returns available:false', async () => {
    mockUsersWhereGet.mockResolvedValue({ empty: false });

    const result = await checkSignupAvailability(reqWithEmail('taken@example.com'));

    expect(result).toEqual({ email: { available: false } });
  });
});

describe('checkSignupAvailability — warm bloom', () => {
  beforeEach(async () => {
    const { DEFAULT_SALT } = await import('../utils/bloom-filter');
    // The handler now sanity-checks the doc salt against DEFAULT_SALT
    // (A-4-05) — fixtures must carry the deployed salt or the loader
    // will drop them.
    mockBloomLoad.mockResolvedValue({
      exists: true,
      data: () => ({
        email: { kind: 'email', salt: DEFAULT_SALT },
        phone: { kind: 'phone', salt: DEFAULT_SALT },
      }),
    });
  });

  it('bloom HIT (maybe present) → falls through to Firestore', async () => {
    mockBloomEmail.has.mockReturnValue(true);
    mockUsersWhereGet.mockResolvedValue({ empty: false });

    const result = await checkSignupAvailability(reqWithEmail('alice@example.com'));

    expect(mockBloomEmail.has).toHaveBeenCalledWith('alice@example.com');
    expect(mockUsersWhereGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ email: { available: false } });
  });

  it('bloom MISS (definitely not present) → skips Firestore + reports available', async () => {
    mockBloomEmail.has.mockReturnValue(false);

    const result = await checkSignupAvailability(reqWithEmail('alice@example.com'));

    expect(mockBloomEmail.has).toHaveBeenCalledWith('alice@example.com');
    expect(mockUsersWhereGet).not.toHaveBeenCalled();
    expect(result).toEqual({ email: { available: true } });
  });

  it('phone path runs canonical normaliser BEFORE bloom probe', async () => {
    mockBloomPhone.has.mockReturnValue(false);

    await checkSignupAvailability(reqWithPhone('919999912345'));

    // Reader probes the canonical E.164 form (with leading +), not the
    // raw input — A-4-01 invariant.
    expect(mockBloomPhone.has).toHaveBeenCalledWith('+919999912345');
  });
});

describe('checkSignupAvailability — salt sanity (A-4-05)', () => {
  it('drops the bloom filter when doc salt disagrees with DEFAULT_SALT', async () => {
    mockBloomLoad.mockResolvedValue({
      exists: true,
      data: () => ({
        email: { kind: 'email', salt: 'stale-salt-from-old-deploy' },
        phone: { kind: 'phone', salt: 'stale-salt-from-old-deploy' },
      }),
    });
    // Even though the bloom would say "miss" if it were used, the
    // mismatched salt forces the loader to drop the filter and the
    // handler MUST fall back to the authoritative Firestore lookup.
    mockBloomEmail.has.mockReturnValue(false);
    mockUsersWhereGet.mockResolvedValue({ empty: true });

    const result = await checkSignupAvailability(reqWithEmail('alice@example.com'));

    expect(mockBloomEmail.has).not.toHaveBeenCalled();
    expect(mockUsersWhereGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ email: { available: true } });
  });
});

describe('checkSignupAvailability — per-app rate limit', () => {
  it('returns empty {} (silent throttle) when the appId bucket is exhausted', async () => {
    // Force the rate-limit transaction to land in the "limit reached" branch.
    mockRateLimitTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        get: async () => ({
          exists: true,
          data: () => ({ count: 999, firstAt: Date.now() }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      return fn(tx);
    });

    const result = await checkSignupAvailability(reqWithEmail('alice@example.com'));
    expect(result).toEqual({});
    // Bloom + Firestore must NOT be touched once we throttle.
    expect(mockBloomLoad).not.toHaveBeenCalled();
    expect(mockUsersWhereGet).not.toHaveBeenCalled();
  });

  it('appId bucket Firestore error fails OPEN (request still served)', async () => {
    mockRateLimitTransaction.mockRejectedValue(new Error('firestore blip'));
    mockBloomLoad.mockResolvedValue({ exists: false });
    mockUsersWhereGet.mockResolvedValue({ empty: true });

    const result = await checkSignupAvailability(reqWithEmail('alice@example.com'));
    expect(result).toEqual({ email: { available: true } });
  });
});

describe('checkSignupAvailability — schema validation', () => {
  beforeEach(() => {
    mockBloomLoad.mockResolvedValue({ exists: false });
  });

  it('rejects payload with neither email nor phone', async () => {
    await expect(
      checkSignupAvailability({
        data: {},
        app: { appId: 'app-123', alreadyConsumed: false },
        rawRequest: { headers: {}, ip: '127.0.0.1' },
      }),
    ).rejects.toBeDefined();
  });

  it('rejects malformed email', async () => {
    await expect(
      checkSignupAvailability(reqWithEmail('not-an-email')),
    ).rejects.toBeDefined();
  });

  it('rejects malformed phone (too short)', async () => {
    await expect(
      checkSignupAvailability(reqWithPhone('12')),
    ).rejects.toBeDefined();
  });
});

describe('checkSignupAvailability — App Check appId fallback', () => {
  it('uses "unknown" as appId when req.app is absent (defensive only)', async () => {
    mockBloomLoad.mockResolvedValue({ exists: false });
    mockUsersWhereGet.mockResolvedValue({ empty: true });

    // Even though enforceAppCheck=true rejects this earlier in the
    // pipeline, the handler defensively guards against a null req.app.
    await expect(
      checkSignupAvailability({
        data: { email: 'alice@example.com' },
        app: undefined,
        rawRequest: { headers: {}, ip: '127.0.0.1' },
      }),
    ).resolves.toEqual({ email: { available: true } });

    expect(mockRateLimitTransaction).toHaveBeenCalled();
  });
});
