/**
 * Tests for the `rebuildSignupBloomFilter` scheduler.
 *
 * The export shape is the v1 `functions.runWith().pubsub.schedule()`
 * trigger; the inner implementation is `runRebuildSignupBloomFilter()`
 * (extracted for testability). We mock `admin.firestore()` to drive
 * the scan + write paths directly without an emulator.
 *
 * Coverage:
 *   - pagination across multiple pages stops cleanly on the empty page
 *   - count() unavailable falls back to MIN_EXPECTED_ITEMS sizing
 *   - server-timestamp version stamp is written on the `_meta/signupBloom` doc
 *   - canonical normalisation parity: phones are normalised via
 *     `utils/phone.ts` so the writer + reader agree (A-4-01).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCountGet,
  mockUsersPageGet,
  mockMetaSet,
  mockOrderBy,
  mockSelect,
  mockLimit,
  mockStartAfter,
} = vi.hoisted(() => ({
  mockCountGet: vi.fn(),
  mockUsersPageGet: vi.fn(),
  mockMetaSet: vi.fn(),
  mockOrderBy: vi.fn(),
  mockSelect: vi.fn(),
  mockLimit: vi.fn(),
  mockStartAfter: vi.fn(),
}));

vi.mock('firebase-admin', () => {
  // Build a chainable users() query terminator that ALWAYS returns the
  // same get() spy so test-cases can sequence pages.
  const usersQuery = {
    orderBy: mockOrderBy,
    select: mockSelect,
    limit: mockLimit,
    startAfter: mockStartAfter,
    get: () => mockUsersPageGet(),
    count: () => ({ get: () => mockCountGet() }),
  };
  // orderBy / select / limit / startAfter all return the same query object.
  mockOrderBy.mockReturnValue(usersQuery);
  mockSelect.mockReturnValue(usersQuery);
  mockLimit.mockReturnValue(usersQuery);
  mockStartAfter.mockReturnValue(usersQuery);

  const collection = vi.fn().mockImplementation((name: string) => {
    if (name === 'users') return usersQuery;
    if (name === '_meta') {
      return {
        doc: () => ({
          set: mockMetaSet,
        }),
      };
    }
    return {};
  });

  const firestoreInstance = { collection };
  const firestoreFn = () => firestoreInstance;
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
  };
  firestoreFn.FieldPath = {
    documentId: () => '__DOC_ID__',
  };

  return {
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
  };
});

vi.mock('firebase-functions', () => ({
  default: {
    runWith: () => ({
      pubsub: {
        schedule: () => ({
          timeZone: () => ({
            onRun: (handler: unknown) => handler,
          }),
        }),
      },
    }),
  },
  runWith: () => ({
    pubsub: {
      schedule: () => ({
        timeZone: () => ({
          onRun: (handler: unknown) => handler,
        }),
      }),
    },
  }),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test (post-mock)
// ---------------------------------------------------------------------------

let runRebuildSignupBloomFilter: () => Promise<{
  scanned: number;
  emailAdded: number;
  phoneAdded: number;
}>;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-prime chain returns after clearAllMocks.
  const usersQuery = {
    orderBy: mockOrderBy,
    select: mockSelect,
    limit: mockLimit,
    startAfter: mockStartAfter,
    get: () => mockUsersPageGet(),
    count: () => ({ get: () => mockCountGet() }),
  };
  mockOrderBy.mockReturnValue(usersQuery);
  mockSelect.mockReturnValue(usersQuery);
  mockLimit.mockReturnValue(usersQuery);
  mockStartAfter.mockReturnValue(usersQuery);

  vi.resetModules();
  const mod = await import('../scheduled/rebuildSignupBloomFilter');
  runRebuildSignupBloomFilter = mod.runRebuildSignupBloomFilter;
});

// Helper: build a Firestore page snapshot stub.
function pageOf(rows: Array<{ profile?: { email?: string; phone?: string } }>) {
  const docs = rows.map((data) => ({ data: () => data }));
  return {
    empty: rows.length === 0,
    size: rows.length,
    docs,
  };
}

describe('runRebuildSignupBloomFilter — pagination', () => {
  it('stops after the first page when it is shorter than STREAM_PAGE_SIZE', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 2 }) });
    // Single short page → should NOT issue a second query.
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([
        { profile: { email: 'a@example.com', phone: '9999912345' } },
        { profile: { email: 'b@example.com' } },
      ]),
    );

    const result = await runRebuildSignupBloomFilter();

    expect(result.scanned).toBe(2);
    expect(result.emailAdded).toBe(2);
    expect(result.phoneAdded).toBe(1);
    // Exactly one page fetched.
    expect(mockUsersPageGet).toHaveBeenCalledTimes(1);
    // Final write happened.
    expect(mockMetaSet).toHaveBeenCalledTimes(1);
  });

  it('paginates across multiple pages and stops on the empty page', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 0 }) });

    // 1000 rows on each of the first two pages, then an empty 3rd page.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      profile: { email: `user-${i}@example.com` },
    }));
    mockUsersPageGet
      .mockResolvedValueOnce(pageOf(fullPage))
      .mockResolvedValueOnce(pageOf(fullPage))
      .mockResolvedValueOnce(pageOf([])); // empty terminator

    const result = await runRebuildSignupBloomFilter();

    expect(result.scanned).toBe(2000);
    expect(result.emailAdded).toBe(2000);
    expect(mockUsersPageGet).toHaveBeenCalledTimes(3);
    // startAfter is invoked on every page after the first.
    expect(mockStartAfter).toHaveBeenCalled();
  });
});

describe('runRebuildSignupBloomFilter — count() fallback', () => {
  it('falls back to MIN_EXPECTED_ITEMS sizing when count() throws', async () => {
    mockCountGet.mockRejectedValue(new Error('count() unavailable'));
    // Empty users page so the rebuild returns quickly.
    mockUsersPageGet.mockResolvedValueOnce(pageOf([]));

    const result = await runRebuildSignupBloomFilter();

    expect(result.scanned).toBe(0);
    // Crucially: the rebuild still completes + writes the doc despite
    // the count() failure.
    expect(mockMetaSet).toHaveBeenCalledTimes(1);
  });
});

describe('runRebuildSignupBloomFilter — write shape', () => {
  it('writes the bloom doc with serverTimestamp version stamp', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 1 }) });
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([{ profile: { email: 'a@example.com' } }]),
    );

    await runRebuildSignupBloomFilter();

    expect(mockMetaSet).toHaveBeenCalledTimes(1);
    const written = mockMetaSet.mock.calls[0][0];
    expect(written.email).toBeDefined();
    expect(written.phone).toBeDefined();
    expect(written.userCount).toBe(1);
    expect(written.version).toBe('__SERVER_TIMESTAMP__');
  });

  it('skips empty / non-string email and phone fields without error', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 4 }) });
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([
        // Empty string — skipped.
        { profile: { email: '', phone: '' } },
        // Wrong type — skipped.
        { profile: { email: 123 as unknown as string } },
        // Missing profile — skipped.
        {},
        // Valid row — counted.
        { profile: { email: 'a@example.com' } },
      ]),
    );

    const result = await runRebuildSignupBloomFilter();

    expect(result.scanned).toBe(4);
    expect(result.emailAdded).toBe(1);
    expect(result.phoneAdded).toBe(0);
  });
});

describe('runRebuildSignupBloomFilter — schema validation (A-4-06)', () => {
  it('skips malformed emails so they do not waste FPR budget', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 3 }) });
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([
        { profile: { email: 'not-an-email' } }, // invalid
        { profile: { email: 'alice@example.com' } }, // valid
        { profile: { email: '   ' } }, // whitespace only — invalid
      ]),
    );

    const result = await runRebuildSignupBloomFilter();
    expect(result.scanned).toBe(3);
    expect(result.emailAdded).toBe(1);
  });

  it('skips malformed phones so they do not waste FPR budget', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 3 }) });
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([
        { profile: { phone: '12' } }, // too short
        { profile: { phone: '+919999912345' } }, // valid
        { profile: { phone: 'not-a-phone' } }, // invalid
      ]),
    );

    const result = await runRebuildSignupBloomFilter();
    expect(result.scanned).toBe(3);
    expect(result.phoneAdded).toBe(1);
  });
});

describe('runRebuildSignupBloomFilter — pagination ordering (A-4-07)', () => {
  it('uses orderBy(documentId()) on the scan query', async () => {
    mockCountGet.mockResolvedValue({ data: () => ({ count: 1 }) });
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([{ profile: { email: 'a@example.com' } }]),
    );

    await runRebuildSignupBloomFilter();

    expect(mockOrderBy).toHaveBeenCalledWith('__DOC_ID__');
  });
});

describe('runRebuildSignupBloomFilter — sizing cap (A-4-10)', () => {
  it('clamps expectedItems to the MAX cap so the serialised filter stays under 1 MiB', async () => {
    // Pretend the users collection has 5M rows. Without the cap the
    // bloom would be sized for 5M items (~6 MB raw) and the Firestore
    // write would fail with "document too large".
    mockCountGet.mockResolvedValue({ data: () => ({ count: 5_000_000 }) });
    mockUsersPageGet.mockResolvedValueOnce(pageOf([]));

    await runRebuildSignupBloomFilter();

    expect(mockMetaSet).toHaveBeenCalledTimes(1);
    const written = mockMetaSet.mock.calls[0][0];
    // Decoded base64 buffer should be well under 1 MiB.
    const emailBytes = Buffer.from(written.email.buffer, 'base64').length;
    const phoneBytes = Buffer.from(written.phone.buffer, 'base64').length;
    expect(emailBytes).toBeLessThan(1_048_576);
    expect(phoneBytes).toBeLessThan(1_048_576);
  });
});

describe('runRebuildSignupBloomFilter — normalisation parity', () => {
  it('writer normalises phone via canonical utils/phone — taken phone is bloom-present in the reader', async () => {
    // Fixture: a user stored with raw 10-digit phone (legacy data).
    mockCountGet.mockResolvedValue({ data: () => ({ count: 1 }) });
    mockUsersPageGet.mockResolvedValueOnce(
      pageOf([{ profile: { phone: '9999912345' } }]),
    );

    await runRebuildSignupBloomFilter();

    expect(mockMetaSet).toHaveBeenCalledTimes(1);
    const written = mockMetaSet.mock.calls[0][0];

    // Re-deserialise the phone bloom and probe the canonical form the
    // reader uses (`+919999912345`). Bloom MUST report present; this
    // proves the writer's normaliser agrees with the reader's, which is
    // the H1 invariant.
    const { BloomFilter } = await import('../utils/bloom-filter');
    const phoneBloom = BloomFilter.deserialise(written.phone);

    expect(phoneBloom.has('+919999912345')).toBe(true);
    // Negative control: raw stored form (without normalisation) should
    // NOT be present — the writer normalised before adding.
    expect(phoneBloom.has('9999912345')).toBe(false);
    // Negative control: a different number should not be present.
    expect(phoneBloom.has('+15555555555')).toBe(false);
  });
});
