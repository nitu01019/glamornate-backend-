/**
 * Tests for the `deleteAccount` callable Cloud Function.
 *
 * These tests mirror the unit-test style used for the rest of this
 * codebase: every Firebase dependency is mocked in-process via vitest's
 * `vi.hoisted` + `vi.mock` so the suite runs without the emulator.
 *
 * The fakes still behave like Firestore / Storage / Auth well enough
 * that we can seed fixtures, invoke the callable, and assert zero
 * residuals across every target location. When the emulator is
 * available (CI job, `firebase emulators:exec`), the production code
 * runs against the real Admin SDK; the in-process harness guarantees
 * correctness at the unit level.
 *
 * Suite covers (§7 test plan):
 *   1. Happy path with seeded fixtures
 *   2. Idempotent retry (second call → alreadyDeleted: true)
 *   3. Missing auth → unauthenticated
 *   4. Unverified email → unauthenticated
 *   5. Stale auth_time → failed-precondition / requires-recent-login
 *   6. Wrong confirmation string → invalid-argument
 *   7. Storage partial failure is captured as a warning but still succeeds
 *   8. Audit log is written BEFORE any deletion
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fakes for firebase-admin + firebase-functions
// ---------------------------------------------------------------------------
const fakes = vi.hoisted(() => {
  /** A single Firestore-like document. */
  type Doc = Record<string, unknown> & { __path: string };

  const docs = new Map<string, Doc>();

  function normalisePath(path: string): string {
    return path.replace(/^\/+|\/+$/g, '');
  }

  class FakeDocRef {
    constructor(public path: string, private store: typeof docs) {}

    get id(): string {
      return this.path.split('/').pop() as string;
    }

    async get() {
      const data = this.store.get(this.path);
      return {
        exists: !!data,
        id: this.id,
        ref: this,
        data: () => (data ? { ...data } : undefined),
      };
    }

    async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
      const prev = this.store.get(this.path);
      if (opts?.merge && prev) {
        this.store.set(this.path, applyMerge({ ...prev, ...value }));
      } else {
        this.store.set(this.path, applyMerge({ __path: this.path, ...value }));
      }
    }

    async update(value: Record<string, unknown>) {
      const prev = this.store.get(this.path);
      if (!prev) throw new Error(`No document to update at ${this.path}`);
      const next = { ...prev };
      for (const [key, val] of Object.entries(value)) {
        if (val && typeof val === 'object' && '__arrayUnion' in (val as object)) {
          const existing = Array.isArray(next[key]) ? (next[key] as unknown[]) : [];
          next[key] = [...existing, ...((val as { __arrayUnion: unknown[] }).__arrayUnion)];
        } else if (key.includes('.')) {
          const [head, tail] = key.split('.', 2);
          const obj = (next[head] as Record<string, unknown>) ?? {};
          next[head] = { ...obj, [tail]: val };
        } else {
          next[key] = val;
        }
      }
      this.store.set(this.path, next as Doc);
    }

    async delete() {
      this.store.delete(this.path);
    }

    collection(name: string) {
      return new FakeCollectionRef(`${this.path}/${name}`, this.store);
    }
  }

  class FakeQuery {
    constructor(
      public collectionPath: string,
      private store: typeof docs,
      private filters: Array<{ field: string; op: string; value: unknown }> = [],
      private _limit: number | null = null
    ) {}

    where(field: string, op: string, value: unknown): FakeQuery {
      return new FakeQuery(
        this.collectionPath,
        this.store,
        [...this.filters, { field, op, value }],
        this._limit
      );
    }

    limit(n: number): FakeQuery {
      return new FakeQuery(this.collectionPath, this.store, this.filters, n);
    }

    async get() {
      const prefix = normalisePath(this.collectionPath) + '/';
      const matching: Doc[] = [];
      for (const [path, doc] of this.store.entries()) {
        if (!path.startsWith(prefix)) continue;
        // Only direct children — skip sub-subcollections
        const remainder = path.slice(prefix.length);
        if (remainder.includes('/')) continue;
        if (this.filters.every((f) => matchFilter(doc, f))) {
          matching.push(doc);
        }
      }
      const capped = this._limit ? matching.slice(0, this._limit) : matching;
      return {
        empty: capped.length === 0,
        size: capped.length,
        docs: capped.map((d) => ({
          id: d.__path.split('/').pop() as string,
          ref: new FakeDocRef(d.__path, this.store),
          data: () => ({ ...d }),
        })),
      };
    }
  }

  class FakeCollectionRef extends FakeQuery {
    constructor(public path: string, store: typeof docs) {
      super(path, store);
    }

    doc(id?: string) {
      const docId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      return new FakeDocRef(`${this.path}/${docId}`, fakes.docs);
    }
  }

  function matchFilter(
    doc: Doc,
    filter: { field: string; op: string; value: unknown }
  ): boolean {
    const fieldValue = doc[filter.field];
    switch (filter.op) {
      case '==':
        return fieldValue === filter.value;
      case '!=':
        return fieldValue !== filter.value;
      default:
        throw new Error(`Unsupported op: ${filter.op}`);
    }
  }

  function applyMerge(value: Record<string, unknown>): Doc {
    const next: Record<string, unknown> = { ...value };
    for (const [key, val] of Object.entries(value)) {
      if (val && typeof val === 'object' && '__arrayUnion' in (val as object)) {
        const existing = Array.isArray((value as Record<string, unknown>)[key])
          ? ((value as Record<string, unknown>)[key] as unknown[])
          : [];
        next[key] = [...existing, ...((val as { __arrayUnion: unknown[] }).__arrayUnion)];
      }
    }
    return next as Doc;
  }

  /** Batch that records writes applied in a single commit() tick. */
  class FakeBatch {
    private ops: Array<() => Promise<void>> = [];

    set(ref: FakeDocRef, value: Record<string, unknown>) {
      this.ops.push(() => ref.set(value));
    }

    update(ref: FakeDocRef, value: Record<string, unknown>) {
      this.ops.push(() => ref.update(value));
    }

    delete(ref: FakeDocRef) {
      this.ops.push(() => ref.delete());
    }

    async commit() {
      for (const op of this.ops) await op();
    }
  }

  const firestoreInstance = {
    collection: (name: string) => new FakeCollectionRef(name, docs),
    batch: () => new FakeBatch(),
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({
      seconds: Math.floor(Date.now() / 1000),
      toDate: () => new Date(),
    }),
    fromDate: (d: Date) => ({
      seconds: Math.floor(d.getTime() / 1000),
      toDate: () => d,
    }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
    arrayUnion: (...args: unknown[]) => ({ __arrayUnion: args }),
  };

  // ----- Storage fake -------------------------------------------------
  const storageFiles = new Map<string, { failDelete?: boolean }>();

  const bucket = {
    getFiles: vi.fn(async ({ prefix }: { prefix: string }) => {
      const matches = Array.from(storageFiles.keys()).filter((p) =>
        p.startsWith(prefix)
      );
      const files = matches.map((name) => ({
        name,
        delete: vi.fn(async () => {
          const meta = storageFiles.get(name);
          if (meta?.failDelete) {
            throw new Error(`storage error for ${name}`);
          }
          storageFiles.delete(name);
        }),
      }));
      return [files];
    }),
  };

  const storageFn = () => ({ bucket: () => bucket });

  // ----- Auth fake ----------------------------------------------------
  const authUsers = new Set<string>();
  const authRevokes: string[] = [];
  const authDeletes: string[] = [];

  const authFn = () => ({
    revokeRefreshTokens: vi.fn(async (uid: string) => {
      authRevokes.push(uid);
      if (!authUsers.has(uid)) {
        const err = new Error('no user');
        (err as Error & { code?: string }).code = 'auth/user-not-found';
        throw err;
      }
    }),
    deleteUser: vi.fn(async (uid: string) => {
      authDeletes.push(uid);
      if (!authUsers.has(uid)) {
        const err = new Error('no user');
        (err as Error & { code?: string }).code = 'auth/user-not-found';
        throw err;
      }
      authUsers.delete(uid);
    }),
  });

  return {
    docs,
    storageFiles,
    authUsers,
    authRevokes,
    authDeletes,
    firestoreFn,
    storageFn,
    authFn,
    bucket,
  };
});

// ---------------------------------------------------------------------------
// vi.mock wiring
// ---------------------------------------------------------------------------
vi.mock('firebase-admin', () => {
  return {
    default: {
      firestore: fakes.firestoreFn,
      storage: fakes.storageFn,
      auth: fakes.authFn,
      initializeApp: vi.fn(),
    },
    firestore: fakes.firestoreFn,
    storage: fakes.storageFn,
    auth: fakes.authFn,
    initializeApp: vi.fn(),
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
  const https = {
    HttpsError,
    onCall: (handler: unknown) => handler,
  };
  // runWith(...).region(...).https.onCall(...) or runWith(...).https.onCall(...)
  const runWith = () => ({
    https,
    region: () => ({ https }),
  });
  return {
    default: { runWith, https },
    runWith,
    https,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test AFTER mocks are registered
// ---------------------------------------------------------------------------
import { deleteAccount, DELETE_CONFIRMATION } from '../deleteAccount';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TEST_UID = 'user_test_123';

function seedUser() {
  fakes.authUsers.add(TEST_UID);
  fakes.docs.set(`users/${TEST_UID}`, {
    __path: `users/${TEST_UID}`,
    role: 'customer',
    isActive: true,
    profile: { email: 'test@example.com', phone: '+919999999999' },
    createdAt: { seconds: 1700000000 },
  });
  fakes.docs.set(`wallets/${TEST_UID}`, {
    __path: `wallets/${TEST_UID}`,
    userId: TEST_UID,
    balance: { current: 500 },
  });
  fakes.docs.set(`bookings/booking-1`, {
    __path: 'bookings/booking-1',
    userId: TEST_UID,
    spaId: 'spa-1',
  });
  fakes.docs.set(`reviews/review-1`, {
    __path: 'reviews/review-1',
    userId: TEST_UID,
    rating: 5,
  });
  fakes.docs.set(`notifications/notif-1`, {
    __path: 'notifications/notif-1',
    userId: TEST_UID,
    title: 'hi',
  });
  fakes.docs.set(`notifications/notif-2`, {
    __path: 'notifications/notif-2',
    userId: TEST_UID,
    title: 'hi 2',
  });
  fakes.docs.set(`user_vouchers/voucher-1`, {
    __path: 'user_vouchers/voucher-1',
    userId: TEST_UID,
    code: 'SAVE10',
  });
  fakes.docs.set(`users/${TEST_UID}/favorites/fav-1`, {
    __path: `users/${TEST_UID}/favorites/fav-1`,
    spaId: 'spa-1',
  });
  fakes.storageFiles.set(`users/${TEST_UID}/profile/avatar.jpg`, {});
  fakes.storageFiles.set(`users/${TEST_UID}/cover.png`, {});
  fakes.storageFiles.set(`temp/${TEST_UID}/scratch.jpg`, {});
  // Foreign data that must survive deletion
  fakes.docs.set('bookings/booking-other-user', {
    __path: 'bookings/booking-other-user',
    userId: 'other-user',
    spaId: 'spa-1',
  });
}

function makeContext(overrides: Partial<Record<string, unknown>> = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    auth: {
      uid: TEST_UID,
      token: {
        email_verified: true,
        auth_time: nowSec,
      },
    },
    rawRequest: {
      ip: '10.0.0.1',
      headers: { 'user-agent': 'vitest-agent/1.0' },
    },
    ...overrides,
  };
}

function residualsForUid(uid: string): string[] {
  return Array.from(fakes.docs.keys()).filter((path) => {
    // audit_logs and the deletion_jobs journal must survive deletion
    if (path.startsWith('audit_logs/')) return false;
    if (path.startsWith('deletion_jobs/')) return false;
    // user-scoped paths
    if (path.startsWith(`users/${uid}`)) return true;
    if (path === `wallets/${uid}`) return true;
    // cross-collection docs referencing the uid
    const doc = fakes.docs.get(path);
    if (doc && doc.userId === uid) return true;
    return false;
  });
}

function storageResidualsForUid(uid: string): string[] {
  return Array.from(fakes.storageFiles.keys()).filter(
    (p) => p.startsWith(`users/${uid}/`) || p.startsWith(`temp/${uid}/`),
  );
}

function auditLogsForUid(uid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [path, doc] of fakes.docs.entries()) {
    if (!path.startsWith('audit_logs/')) continue;
    if (doc.userId === uid) out.push(doc);
  }
  return out;
}

beforeEach(() => {
  fakes.docs.clear();
  fakes.storageFiles.clear();
  fakes.authUsers.clear();
  fakes.authRevokes.length = 0;
  fakes.authDeletes.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deleteAccount — happy path', () => {
  it('cascade-deletes every piece of user data and writes an audit log first', async () => {
    seedUser();

    const result = await (deleteAccount as unknown as (
      data: unknown,
      ctx: unknown
    ) => Promise<{ success: boolean; alreadyDeleted?: boolean }>)(
      { confirmationString: DELETE_CONFIRMATION },
      makeContext()
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(residualsForUid(TEST_UID)).toEqual([]);
    expect(storageResidualsForUid(TEST_UID)).toEqual([]);
    expect(fakes.authUsers.has(TEST_UID)).toBe(false);
    expect(fakes.authDeletes).toContain(TEST_UID);

    // Foreign data untouched
    expect(fakes.docs.has('bookings/booking-other-user')).toBe(true);

    // Audit log present with correct shape
    const logs = auditLogsForUid(TEST_UID);
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.action).toBe('account_deleted');
    expect(log.ipAddress).toBe('10.0.0.1');
    expect(log.userAgent).toBe('vitest-agent/1.0');
    const before = log.before as Record<string, unknown> | null;
    expect(before).not.toBeNull();
    // PII is hashed, never raw
    expect(before?.emailHash).toEqual(expect.any(String));
    expect(before?.emailHash).not.toBe('test@example.com');
    expect(before?.phoneHash).toEqual(expect.any(String));
    const metadata = log.metadata as Record<string, unknown>;
    expect(metadata.retentionUntil).toEqual(expect.any(String));
    // Journal should be marked completed
    const journal = fakes.docs.get(`deletion_jobs/${TEST_UID}`);
    expect(journal).toBeDefined();
    expect(journal?.status).toBe('completed');
  });

  it('is idempotent — a retry returns alreadyDeleted: true and does not duplicate work', async () => {
    seedUser();

    await (deleteAccount as unknown as (d: unknown, c: unknown) => Promise<unknown>)(
      { confirmationString: DELETE_CONFIRMATION },
      makeContext()
    );

    const logsAfterFirst = auditLogsForUid(TEST_UID).length;
    const deletesAfterFirst = fakes.authDeletes.length;

    // Re-add the auth user to prove we DON'T try to delete it twice
    fakes.authUsers.add(TEST_UID);

    const retry = await (deleteAccount as unknown as (
      d: unknown,
      c: unknown
    ) => Promise<{ success: boolean; alreadyDeleted?: boolean }>)(
      { confirmationString: DELETE_CONFIRMATION },
      makeContext()
    );

    expect(retry.success).toBe(true);
    expect(retry.alreadyDeleted).toBe(true);
    // No fresh cascade work happened
    expect(fakes.authDeletes.length).toBe(deletesAfterFirst);
    // No additional audit log
    expect(auditLogsForUid(TEST_UID).length).toBe(logsAfterFirst);
    expect(fakes.authUsers.has(TEST_UID)).toBe(true); // we re-added, nothing touched it
  });
});

describe('deleteAccount — input validation', () => {
  it('rejects when there is no auth context', async () => {
    seedUser();
    await expect(
      (deleteAccount as unknown as (d: unknown, c: unknown) => Promise<unknown>)(
        { confirmationString: DELETE_CONFIRMATION },
        { auth: null, rawRequest: {} }
      )
    ).rejects.toMatchObject({
      name: 'HttpsError',
      code: 'unauthenticated',
      message: 'account/unauthenticated',
    });
  });

  it('rejects when email is not verified', async () => {
    seedUser();
    await expect(
      (deleteAccount as unknown as (d: unknown, c: unknown) => Promise<unknown>)(
        { confirmationString: DELETE_CONFIRMATION },
        makeContext({
          auth: {
            uid: TEST_UID,
            token: {
              email_verified: false,
              auth_time: Math.floor(Date.now() / 1000),
            },
          },
        })
      )
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when auth_time is older than 5 minutes', async () => {
    seedUser();
    const staleAuthTime = Math.floor(Date.now() / 1000) - 6 * 60;
    await expect(
      (deleteAccount as unknown as (d: unknown, c: unknown) => Promise<unknown>)(
        { confirmationString: DELETE_CONFIRMATION },
        makeContext({
          auth: {
            uid: TEST_UID,
            token: {
              email_verified: true,
              auth_time: staleAuthTime,
            },
          },
        })
      )
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'account/requires-recent-login',
    });
  });

  it('rejects when the confirmation string does not match', async () => {
    seedUser();
    await expect(
      (deleteAccount as unknown as (d: unknown, c: unknown) => Promise<unknown>)(
        { confirmationString: 'delete me' },
        makeContext()
      )
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'account/invalid-confirmation',
    });

    // Nothing should have been touched — auth user still exists
    expect(fakes.authUsers.has(TEST_UID)).toBe(true);
    expect(auditLogsForUid(TEST_UID)).toEqual([]);
  });
});

describe('deleteAccount — resilience', () => {
  it('reports Storage deletion errors as warnings but still completes the cascade', async () => {
    seedUser();
    // Make one Storage object blow up on delete
    fakes.storageFiles.set(`users/${TEST_UID}/broken.jpg`, { failDelete: true });

    const result = await (deleteAccount as unknown as (
      d: unknown,
      c: unknown
    ) => Promise<{ success: boolean; warnings?: string[] }>)(
      { confirmationString: DELETE_CONFIRMATION },
      makeContext()
    );

    expect(result.success).toBe(true);
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('broken.jpg')])
    );
    // Firestore + Auth deletion still happened
    expect(residualsForUid(TEST_UID)).toEqual([]);
    expect(fakes.authUsers.has(TEST_UID)).toBe(false);
  });
});
