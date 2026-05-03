/**
 * Tests for the `setAdminClaim` callable Cloud Function.
 *
 * Mirrors the in-process fake Firestore + Auth harness used by
 * `dispatchBroadcast.test.ts` and `deleteAccount.test.ts` so the suite
 * runs fast without the emulator while still exercising the exact
 * production code path.
 *
 * Suite covers:
 *   1. Missing auth → `unauthenticated`.
 *   2. Caller without role='admin' → `permission-denied`.
 *   3. Missing/invalid `targetUid` → `invalid-argument`.
 *   4. Target Firestore user does not exist → `failed-precondition`.
 *   5. Target Firestore user has role !== 'admin' → `failed-precondition`.
 *   6. Auth user not found in Firebase Auth → `not-found`.
 *   7. Happy path: `setCustomUserClaims` is invoked with `{ admin: true }`
 *      merged onto any existing claims; response shape is correct.
 *   8. Idempotency: calling twice produces the same end state and does
 *      not error on the second call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fakes (firestore + auth)
// ---------------------------------------------------------------------------
const fakes = vi.hoisted(() => {
  type Doc = Record<string, unknown> & { __path: string };
  const docs = new Map<string, Doc>();

  // ---------- Firestore fake ----------------------------------------------
  class FakeDocRef {
    constructor(public path: string) {}

    get id(): string {
      return this.path.split('/').pop() as string;
    }

    async get() {
      const data = docs.get(this.path);
      return {
        exists: !!data,
        id: this.id,
        ref: this,
        data: () => (data ? { ...data } : undefined),
      };
    }

    async set(value: Record<string, unknown>, opts?: { merge?: boolean }) {
      const prev = docs.get(this.path);
      if (opts?.merge && prev) {
        docs.set(this.path, { ...prev, ...value, __path: this.path } as Doc);
      } else {
        docs.set(this.path, { __path: this.path, ...value } as Doc);
      }
    }

    async update(value: Record<string, unknown>) {
      const prev = docs.get(this.path);
      if (!prev) throw new Error(`No document to update at ${this.path}`);
      docs.set(this.path, { ...prev, ...value } as Doc);
    }

    async delete() {
      docs.delete(this.path);
    }
  }

  class FakeCollectionRef {
    constructor(public path: string) {}

    doc(id: string) {
      return new FakeDocRef(`${this.path}/${id}`);
    }
  }

  // Rate-limit transactions also need this:
  async function runTransaction<T>(
    fn: (txn: {
      get: (ref: FakeDocRef) => ReturnType<FakeDocRef['get']>;
      set: (ref: FakeDocRef, value: Record<string, unknown>) => void;
      update: (ref: FakeDocRef, value: Record<string, unknown>) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const txn = {
      get: (ref: FakeDocRef) => ref.get(),
      set: (ref: FakeDocRef, value: Record<string, unknown>) => {
        void ref.set(value);
      },
      update: (ref: FakeDocRef, value: Record<string, unknown>) => {
        void ref.update(value);
      },
    };
    return fn(txn);
  }

  const firestoreInstance = {
    collection: (name: string) => new FakeCollectionRef(name),
    runTransaction,
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({
      seconds: Math.floor(Date.now() / 1000),
      toMillis: () => Date.now(),
      toDate: () => new Date(),
    }),
    fromMillis: (ms: number) => ({
      seconds: Math.floor(ms / 1000),
      toMillis: () => ms,
      toDate: () => new Date(ms),
    }),
    fromDate: (d: Date) => ({
      seconds: Math.floor(d.getTime() / 1000),
      toMillis: () => d.getTime(),
      toDate: () => d,
    }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
    increment: (n: number) => ({ __increment: n }),
  };

  // ---------- Auth fake ---------------------------------------------------
  /**
   * Fake Auth user store: uid → { customClaims }.
   * Tests can pre-populate via `seedAuthUser(uid, claims?)`.
   */
  type AuthUser = {
    uid: string;
    customClaims?: Record<string, unknown>;
  };
  const authUsers = new Map<string, AuthUser>();
  const claimsCalls: Array<{ uid: string; claims: Record<string, unknown> }> = [];

  const authFn = () => ({
    getUser: vi.fn(async (uid: string) => {
      const u = authUsers.get(uid);
      if (!u) {
        const err = new Error('no user');
        (err as Error & { code?: string }).code = 'auth/user-not-found';
        throw err;
      }
      return u;
    }),
    setCustomUserClaims: vi.fn(
      async (uid: string, claims: Record<string, unknown>) => {
        claimsCalls.push({ uid, claims: { ...claims } });
        const prev = authUsers.get(uid);
        if (prev) {
          authUsers.set(uid, { ...prev, customClaims: { ...claims } });
        } else {
          // Mirror Firebase: setCustomUserClaims throws on missing user, but
          // production callers always run getUser first, so this branch is
          // defensive only.
          const err = new Error('no user');
          (err as Error & { code?: string }).code = 'auth/user-not-found';
          throw err;
        }
      },
    ),
  });

  return {
    docs,
    authUsers,
    claimsCalls,
    firestoreFn,
    authFn,
  };
});

// ---------------------------------------------------------------------------
// vi.mock wiring
// ---------------------------------------------------------------------------
vi.mock('firebase-admin', () => {
  return {
    default: {
      firestore: fakes.firestoreFn,
      auth: fakes.authFn,
      initializeApp: vi.fn(),
    },
    firestore: fakes.firestoreFn,
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
import {
  setAdminClaim,
  type SetAdminClaimInput,
  type SetAdminClaimResult,
} from '../setAdminClaim';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallableFn = (
  data: unknown,
  ctx: unknown,
) => Promise<SetAdminClaimResult>;

const callable = setAdminClaim as unknown as CallableFn;

const ADMIN_UID = 'admin_user';
const TARGET_UID = 'target_admin_user';
const NON_ADMIN_UID = 'customer_99';

function seedFirestoreUser(uid: string, role: string | null) {
  fakes.docs.set(`users/${uid}`, {
    __path: `users/${uid}`,
    role,
  });
}

function seedAuthUser(uid: string, customClaims?: Record<string, unknown>) {
  fakes.authUsers.set(uid, { uid, customClaims });
}

function adminContext() {
  return {
    auth: {
      uid: ADMIN_UID,
      token: {},
    },
    rawRequest: { ip: '10.0.0.1', headers: {} },
  };
}

function nonAdminContext() {
  return {
    auth: {
      uid: NON_ADMIN_UID,
      token: {},
    },
    rawRequest: { ip: '10.0.0.1', headers: {} },
  };
}

const validInput: SetAdminClaimInput = { targetUid: TARGET_UID };

beforeEach(() => {
  fakes.docs.clear();
  fakes.authUsers.clear();
  fakes.claimsCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setAdminClaim — auth gate', () => {
  it('rejects calls without auth as unauthenticated', async () => {
    await expect(
      callable(validInput, { rawRequest: { ip: '1.2.3.4', headers: {} } }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects callers whose Firestore role is not admin', async () => {
    seedFirestoreUser(NON_ADMIN_UID, 'customer');
    seedFirestoreUser(TARGET_UID, 'admin');
    seedAuthUser(TARGET_UID);

    await expect(callable(validInput, nonAdminContext())).rejects.toMatchObject(
      { code: 'permission-denied' },
    );
  });

  it('rejects callers whose Firestore user document does not exist', async () => {
    // No `users/${ADMIN_UID}` doc seeded → caller is not a verified admin.
    seedFirestoreUser(TARGET_UID, 'admin');
    seedAuthUser(TARGET_UID);

    await expect(callable(validInput, adminContext())).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('setAdminClaim — payload validation', () => {
  it('rejects missing targetUid as invalid-argument', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    await expect(callable({}, adminContext())).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('rejects empty-string targetUid as invalid-argument', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    await expect(
      callable({ targetUid: '' }, adminContext()),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects non-string targetUid as invalid-argument', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    await expect(
      callable({ targetUid: 12345 }, adminContext()),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('setAdminClaim — target precondition', () => {
  it('rejects target with non-admin Firestore role as failed-precondition', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    seedFirestoreUser(TARGET_UID, 'customer');
    seedAuthUser(TARGET_UID);

    await expect(callable(validInput, adminContext())).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(fakes.claimsCalls).toHaveLength(0);
  });

  it('rejects target without a Firestore user document as failed-precondition', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    // No target Firestore doc
    seedAuthUser(TARGET_UID);

    await expect(callable(validInput, adminContext())).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(fakes.claimsCalls).toHaveLength(0);
  });

  it('rejects target whose Auth record is missing as not-found', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    seedFirestoreUser(TARGET_UID, 'admin');
    // No auth user seeded

    await expect(callable(validInput, adminContext())).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(fakes.claimsCalls).toHaveLength(0);
  });
});

describe('setAdminClaim — happy path', () => {
  it('sets {admin: true} and returns the expected envelope', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    seedFirestoreUser(TARGET_UID, 'admin');
    seedAuthUser(TARGET_UID);

    const result = await callable(validInput, adminContext());

    expect(result).toEqual({
      success: true,
      uid: TARGET_UID,
      claimsSet: { admin: true },
      before: { role: 'admin' },
    });

    expect(fakes.claimsCalls).toHaveLength(1);
    expect(fakes.claimsCalls[0]).toEqual({
      uid: TARGET_UID,
      claims: { admin: true },
    });
  });

  it('preserves existing custom claims when merging', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    seedFirestoreUser(TARGET_UID, 'admin');
    seedAuthUser(TARGET_UID, { someOtherClaim: 'preserved' });

    const result = await callable(validInput, adminContext());
    expect(result.success).toBe(true);

    expect(fakes.claimsCalls).toHaveLength(1);
    expect(fakes.claimsCalls[0].claims).toEqual({
      someOtherClaim: 'preserved',
      admin: true,
    });
  });
});

describe('setAdminClaim — idempotency', () => {
  it('does not error on a second invocation and produces the same end state', async () => {
    seedFirestoreUser(ADMIN_UID, 'admin');
    seedFirestoreUser(TARGET_UID, 'admin');
    seedAuthUser(TARGET_UID);

    const first = await callable(validInput, adminContext());
    expect(first.success).toBe(true);

    const second = await callable(validInput, adminContext());
    expect(second).toEqual({
      success: true,
      uid: TARGET_UID,
      claimsSet: { admin: true },
      before: { role: 'admin' },
    });

    // Both calls invoked setCustomUserClaims; both produce { admin: true }.
    expect(fakes.claimsCalls).toHaveLength(2);
    for (const call of fakes.claimsCalls) {
      expect(call.uid).toBe(TARGET_UID);
      expect(call.claims).toMatchObject({ admin: true });
    }

    // The fake auth store reflects the merged claims.
    const stored = fakes.authUsers.get(TARGET_UID);
    expect(stored?.customClaims).toMatchObject({ admin: true });
  });
});
