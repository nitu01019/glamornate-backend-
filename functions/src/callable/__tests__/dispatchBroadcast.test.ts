/**
 * Tests for the `dispatchBroadcast` callable Cloud Function.
 *
 * Mirrors the in-process fake Firestore + Auth harness used by
 * `deleteAccount.test.ts` so the suite runs fast without the emulator
 * while still exercising the exact production code path.
 *
 * Suite covers (PHASE_4.md §4 — 4C Exit Criteria):
 *   1. Non-admin caller → `permission-denied`.
 *   2. 50-user fan-out writes exactly 50 `notifications` docs, each with
 *      `type: 'broadcast'` and a populated `expiresAt`.
 *   3. Idempotent retry — calling with the same `broadcastId` twice must
 *      produce exactly 50 notifications total (not 100).
 *   4. Recipients journal records every userId exactly once.
 *   5. Audience filter `{ roles: ['customer'] }` only reaches customers.
 *   6. Missing auth → `unauthenticated`.
 *   7. Invalid payload (empty title) → `invalid-argument`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fakes (identical shape to deleteAccount.test.ts)
// ---------------------------------------------------------------------------
const fakes = vi.hoisted(() => {
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
        this.store.set(this.path, { ...prev, ...value, __path: this.path } as Doc);
      } else {
        this.store.set(this.path, { __path: this.path, ...value } as Doc);
      }
    }

    async update(value: Record<string, unknown>) {
      const prev = this.store.get(this.path);
      if (!prev) throw new Error(`No document to update at ${this.path}`);
      const next: Record<string, unknown> = { ...prev };
      for (const [key, val] of Object.entries(value)) {
        if (val && typeof val === 'object' && '__arrayUnion' in (val as object)) {
          const existing = Array.isArray(next[key]) ? (next[key] as unknown[]) : [];
          const additions = (val as { __arrayUnion: unknown[] }).__arrayUnion;
          const merged = [...existing];
          for (const item of additions) {
            if (!merged.includes(item)) merged.push(item);
          }
          next[key] = merged;
        } else if (val && typeof val === 'object' && '__increment' in (val as object)) {
          const prevN = typeof next[key] === 'number' ? (next[key] as number) : 0;
          next[key] = prevN + (val as { __increment: number }).__increment;
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
      protected store: typeof docs,
      protected filters: Array<{ field: string; op: string; value: unknown }> = [],
      protected _limit: number | null = null,
      protected _orderBy: string | null = null,
      protected _startAfterId: string | null = null,
    ) {}

    where(field: string, op: string, value: unknown): FakeQuery {
      return new FakeQuery(
        this.collectionPath,
        this.store,
        [...this.filters, { field, op, value }],
        this._limit,
        this._orderBy,
        this._startAfterId,
      );
    }

    limit(n: number): FakeQuery {
      return new FakeQuery(
        this.collectionPath,
        this.store,
        this.filters,
        n,
        this._orderBy,
        this._startAfterId,
      );
    }

    orderBy(field: string): FakeQuery {
      return new FakeQuery(
        this.collectionPath,
        this.store,
        this.filters,
        this._limit,
        field,
        this._startAfterId,
      );
    }

    startAfter(cursor: { id: string }): FakeQuery {
      return new FakeQuery(
        this.collectionPath,
        this.store,
        this.filters,
        this._limit,
        this._orderBy,
        cursor.id,
      );
    }

    async get() {
      const prefix = normalisePath(this.collectionPath) + '/';
      const matching: Doc[] = [];
      for (const [path, doc] of this.store.entries()) {
        if (!path.startsWith(prefix)) continue;
        const remainder = path.slice(prefix.length);
        if (remainder.includes('/')) continue;
        if (this.filters.every((f) => matchFilter(doc, f))) {
          matching.push(doc);
        }
      }

      // Deterministic order by id (document name) for pagination
      matching.sort((a, b) => {
        const ap = a.__path.split('/').pop() ?? '';
        const bp = b.__path.split('/').pop() ?? '';
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      });

      let sliced = matching;
      if (this._startAfterId) {
        const idx = matching.findIndex(
          (d) => (d.__path.split('/').pop() ?? '') === this._startAfterId,
        );
        if (idx >= 0) sliced = matching.slice(idx + 1);
      }
      const capped = this._limit ? sliced.slice(0, this._limit) : sliced;
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
      return new FakeDocRef(`${this.path}/${docId}`, this.store);
    }
  }

  function matchFilter(
    doc: Doc,
    filter: { field: string; op: string; value: unknown },
  ): boolean {
    const fieldValue = doc[filter.field];
    switch (filter.op) {
      case '==':
        return fieldValue === filter.value;
      case '!=':
        return fieldValue !== filter.value;
      case '<=':
        return typeof fieldValue === 'number' && typeof filter.value === 'number'
          ? fieldValue <= (filter.value as number)
          : false;
      default:
        throw new Error(`Unsupported op: ${filter.op}`);
    }
  }

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

  async function runTransaction<T>(
    fn: (txn: {
      get: (ref: FakeDocRef) => ReturnType<FakeDocRef['get']>;
      set: (ref: FakeDocRef, value: Record<string, unknown>) => void;
      update: (ref: FakeDocRef, value: Record<string, unknown>) => void;
    }) => Promise<T>,
  ): Promise<T> {
    // Serialise transactions — the fake is single-threaded so no lock needed.
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
    collection: (name: string) => new FakeCollectionRef(name, docs),
    batch: () => new FakeBatch(),
    runTransaction,
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({
      seconds: Math.floor(Date.now() / 1000),
      toMillis: () => Date.now(),
      toDate: () => new Date(),
    }),
    fromDate: (d: Date) => ({
      seconds: Math.floor(d.getTime() / 1000),
      toMillis: () => d.getTime(),
      toDate: () => d,
    }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
    arrayUnion: (...args: unknown[]) => ({ __arrayUnion: args }),
    increment: (n: number) => ({ __increment: n }),
  };

  return {
    docs,
    firestoreFn,
  };
});

// ---------------------------------------------------------------------------
// vi.mock wiring
// ---------------------------------------------------------------------------
vi.mock('firebase-admin', () => {
  return {
    default: {
      firestore: fakes.firestoreFn,
      initializeApp: vi.fn(),
    },
    firestore: fakes.firestoreFn,
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
  dispatchBroadcast,
  type DispatchBroadcastInput,
  type DispatchBroadcastResult,
} from '../dispatchBroadcast';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallableFn = (
  data: unknown,
  ctx: unknown,
) => Promise<DispatchBroadcastResult>;

const callable = dispatchBroadcast as unknown as CallableFn;

const ADMIN_UID = 'admin_user';
const CUSTOMER_UID = 'customer_99';

function seedUsers(count: number, role: 'customer' | 'spa_owner' = 'customer') {
  for (let i = 0; i < count; i++) {
    const uid = `${role}_${String(i).padStart(3, '0')}`;
    fakes.docs.set(`users/${uid}`, {
      __path: `users/${uid}`,
      role,
      isActive: true,
    });
  }
}

function seedAdmin() {
  fakes.docs.set(`users/${ADMIN_UID}`, {
    __path: `users/${ADMIN_UID}`,
    role: 'admin',
    isActive: true,
  });
}

function adminContext(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    auth: {
      uid: ADMIN_UID,
      token: {
        admin: true,
      },
    },
    rawRequest: { ip: '10.0.0.1', headers: {} },
    ...overrides,
  };
}

function nonAdminContext() {
  return {
    auth: {
      uid: CUSTOMER_UID,
      token: {},
    },
    rawRequest: { ip: '10.0.0.1', headers: {} },
  };
}

function broadcastInput(
  partial: Partial<DispatchBroadcastInput> = {},
): DispatchBroadcastInput {
  return {
    audience: 'all',
    title: 'Monsoon offer',
    body: '50 percent off all facials this weekend only.',
    ...partial,
  };
}

function notificationDocs() {
  return Array.from(fakes.docs.entries())
    .filter(([path]) => path.startsWith('notifications/'))
    .map(([, data]) => data);
}

beforeEach(() => {
  fakes.docs.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchBroadcast — admin gate', () => {
  it('rejects calls without auth', async () => {
    await expect(
      callable(broadcastInput(), { rawRequest: { ip: '1.2.3.4', headers: {} } }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-admin callers with permission-denied', async () => {
    fakes.docs.set(`users/${CUSTOMER_UID}`, {
      __path: `users/${CUSTOMER_UID}`,
      role: 'customer',
      isActive: true,
    });
    await expect(
      callable(broadcastInput(), nonAdminContext()),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('accepts admin via user document role even without custom claim', async () => {
    seedAdmin();
    seedUsers(3);
    const result = await callable(
      broadcastInput({ audience: { roles: ['customer'] } }),
      {
        auth: {
          uid: ADMIN_UID,
          token: {}, // no `admin: true` claim
        },
        rawRequest: { ip: '10.0.0.1', headers: {} },
      },
    );
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(3);
  });
});

describe('dispatchBroadcast — 50-user fan-out', () => {
  it('writes exactly one notification per target user with expiresAt set', async () => {
    seedAdmin();
    seedUsers(50);

    const result = await callable(
      broadcastInput({ audience: { roles: ['customer'] } }),
      adminContext(),
    );

    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(50);
    expect(result.audienceSize).toBe(50);
    expect(result.alreadyDispatched).toBe(false);

    const notifs = notificationDocs();
    expect(notifs).toHaveLength(50);

    // Each notification must carry the broadcast metadata the schema promises.
    for (const n of notifs) {
      expect(n.type).toBe('broadcast');
      expect(n.read).toBe(false);
      expect(n.readAt).toBeNull();
      expect(n.expiresAt).toBeDefined();
      expect(n.title).toBe('Monsoon offer');
      expect(n.body).toBe('50 percent off all facials this weekend only.');
      expect(typeof n.broadcastId).toBe('string');
    }

    // Exactly one notification per user
    const userIds = new Set(notifs.map((n) => n.userId));
    expect(userIds.size).toBe(50);
  });
});

describe('dispatchBroadcast — idempotency', () => {
  it('does not duplicate notifications when called twice with the same broadcastId', async () => {
    seedAdmin();
    seedUsers(50);

    const firstResult = await callable(
      broadcastInput({
        broadcastId: 'bcast_stable_123',
        audience: { roles: ['customer'] },
      }),
      adminContext(),
    );
    expect(firstResult.dispatched).toBe(50);
    expect(firstResult.alreadyDispatched).toBe(false);

    const secondResult = await callable(
      broadcastInput({
        broadcastId: 'bcast_stable_123',
        audience: { roles: ['customer'] },
      }),
      adminContext(),
    );
    expect(secondResult.dispatched).toBe(0);
    expect(secondResult.alreadyDispatched).toBe(true);
    expect(secondResult.totalRecipients).toBe(50);

    // Still only 50 notification docs
    expect(notificationDocs()).toHaveLength(50);

    // Journal records every userId exactly once
    const journal = fakes.docs.get('broadcast_jobs/bcast_stable_123');
    expect(journal).toBeDefined();
    const recipients = (journal as Record<string, unknown>).recipients as string[];
    expect(new Set(recipients).size).toBe(50);
  });
});

describe('dispatchBroadcast — audience filters', () => {
  it('respects roles filter and skips non-matching users', async () => {
    seedAdmin();
    seedUsers(5, 'customer');
    seedUsers(3, 'spa_owner');

    const result = await callable(
      broadcastInput({ audience: { roles: ['customer'] } }),
      adminContext(),
    );
    expect(result.dispatched).toBe(5);

    const notifs = notificationDocs();
    expect(notifs).toHaveLength(5);
    for (const n of notifs) {
      expect(String(n.userId).startsWith('customer_')).toBe(true);
    }
  });
});

describe('dispatchBroadcast — validation', () => {
  it('rejects an empty title', async () => {
    seedAdmin();
    await expect(
      callable({ audience: 'all', title: '', body: 'hi' }, adminContext()),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
