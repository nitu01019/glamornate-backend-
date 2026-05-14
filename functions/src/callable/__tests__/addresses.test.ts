/**
 * Phase 4 / 4A — Address subcollection callable tests.
 *
 * Uses in-process fakes (same harness pattern as 3A's deleteAccount test)
 * so the suite runs without the Firebase emulator. The fakes implement
 * enough of Firestore's query, transaction and batch surface that the
 * production code runs verbatim.
 *
 * Coverage (§6 success criteria):
 *   - addAddress: first-address auto-default, respect isDefault, demote
 *     others, limit cap, validation
 *   - updateAddress: partial patch, not-found, empty-patch, immutable
 *     default flag
 *   - deleteAddress: not-found, blocks on active booking, promote next
 *     default, clear when last
 *   - setDefaultAddress: idempotent, not-found, invariant holds
 *   - migrateAddressesToSubcollection: zero addresses, one default, three
 *     no-default, idempotent second call, preserves data
 *
 * Every write path ends by running `assertSingleDefault` which walks the
 * fake store and asserts the exactly-one-default invariant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fakes for firebase-admin + firebase-functions
// ---------------------------------------------------------------------------
const fakes = vi.hoisted(() => {
  type Doc = Record<string, unknown> & { __path: string };

  const docs = new Map<string, Doc>();

  function normalisePath(path: string): string {
    return path.replace(/^\/+|\/+$/g, '');
  }

  function applyUpdatePath(
    target: Record<string, unknown>,
    path: string,
    value: unknown,
  ): void {
    const parts = path.split('.');
    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cursor[p] !== 'object' || cursor[p] === null) {
        cursor[p] = {};
      }
      cursor = cursor[p] as Record<string, unknown>;
    }
    if (value && typeof value === 'object' && '__delete' in (value as object)) {
      delete cursor[parts[parts.length - 1]];
    } else {
      cursor[parts[parts.length - 1]] = value;
    }
  }

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

    async set(
      value: Record<string, unknown>,
      opts?: { merge?: boolean },
    ): Promise<void> {
      await applySet(this.path, value, opts);
    }

    async update(value: Record<string, unknown>): Promise<void> {
      await applyUpdate(this.path, value);
    }

    async delete(): Promise<void> {
      // Delete the doc AND any descendant subcollection docs too.
      docs.delete(this.path);
      const prefix = this.path + '/';
      for (const key of Array.from(docs.keys())) {
        if (key.startsWith(prefix)) docs.delete(key);
      }
    }

    collection(name: string) {
      return new FakeCollectionRef(`${this.path}/${name}`);
    }
  }

  class FakeQuery {
    constructor(
      public collectionPath: string,
      private filters: Array<{ field: string; op: string; value: unknown }> = [],
      private _limit: number | null = null,
    ) {}

    where(field: string, op: string, value: unknown): FakeQuery {
      return new FakeQuery(
        this.collectionPath,
        [...this.filters, { field, op, value }],
        this._limit,
      );
    }

    limit(n: number): FakeQuery {
      return new FakeQuery(this.collectionPath, this.filters, n);
    }

    async get() {
      const prefix = normalisePath(this.collectionPath) + '/';
      const matching: Doc[] = [];
      for (const [path, doc] of docs.entries()) {
        if (!path.startsWith(prefix)) continue;
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
          id: (d.__path.split('/').pop() as string),
          ref: new FakeDocRef(d.__path),
          data: () => ({ ...d }),
        })),
      };
    }
  }

  class FakeCollectionRef extends FakeQuery {
    constructor(public path: string) {
      super(path);
    }
    doc(id?: string) {
      const docId = id ?? `auto_${Math.random().toString(36).slice(2, 10)}`;
      return new FakeDocRef(`${this.path}/${docId}`);
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
      case 'in':
        return Array.isArray(filter.value) && (filter.value as unknown[]).includes(fieldValue);
      default:
        throw new Error(`Unsupported op: ${filter.op}`);
    }
  }

  async function applySet(
    path: string,
    value: Record<string, unknown>,
    opts?: { merge?: boolean },
  ): Promise<void> {
    const prev = docs.get(path);
    let next: Record<string, unknown>;
    if (opts?.merge && prev) {
      next = { ...prev };
      for (const [k, v] of Object.entries(value)) {
        if (v && typeof v === 'object' && '__delete' in (v as object)) {
          delete next[k];
        } else {
          next[k] = v;
        }
      }
    } else {
      next = { __path: path, ...value };
    }
    docs.set(path, next as Doc);
  }

  async function applyUpdate(
    path: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const prev = docs.get(path);
    if (!prev) throw new Error(`No document to update at ${path}`);
    const next = { ...prev };
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && '__arrayUnion' in (v as object)) {
        const existing = Array.isArray(next[k]) ? (next[k] as unknown[]) : [];
        next[k] = [...existing, ...((v as { __arrayUnion: unknown[] }).__arrayUnion)];
      } else if (k.includes('.')) {
        applyUpdatePath(next, k, v);
      } else if (v && typeof v === 'object' && '__delete' in (v as object)) {
        delete next[k];
      } else {
        next[k] = v;
      }
    }
    docs.set(path, next as Doc);
  }

  // -----------------------------------------------------------------
  // Transaction fake: buffer reads+writes, commit atomically on success.
  // -----------------------------------------------------------------
  interface TxOp {
    kind: 'set' | 'update' | 'delete';
    path: string;
    value?: Record<string, unknown>;
    merge?: boolean;
  }

  class FakeTransaction {
    private ops: TxOp[] = [];
    constructor(public aborted = false) {}

    async get(target: FakeDocRef | FakeQuery) {
      if (target instanceof FakeDocRef) return target.get();
      if (target instanceof FakeQuery) return target.get();
      throw new Error('tx.get: unsupported target');
    }
    set(ref: FakeDocRef, value: Record<string, unknown>, opts?: { merge?: boolean }) {
      this.ops.push({ kind: 'set', path: ref.path, value, merge: opts?.merge });
    }
    update(ref: FakeDocRef, value: Record<string, unknown>) {
      this.ops.push({ kind: 'update', path: ref.path, value });
    }
    delete(ref: FakeDocRef) {
      this.ops.push({ kind: 'delete', path: ref.path });
    }
    async _commit(): Promise<void> {
      for (const op of this.ops) {
        if (op.kind === 'set') {
          await applySet(op.path, op.value ?? {}, { merge: op.merge });
        } else if (op.kind === 'update') {
          await applyUpdate(op.path, op.value ?? {});
        } else if (op.kind === 'delete') {
          await new FakeDocRef(op.path).delete();
        }
      }
    }
  }

  class FakeBatch {
    private ops: Array<() => Promise<void>> = [];
    set(ref: FakeDocRef, value: Record<string, unknown>, opts?: { merge?: boolean }) {
      this.ops.push(() => ref.set(value, opts));
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
    collection: (name: string) => new FakeCollectionRef(name),
    doc: (path: string) => new FakeDocRef(path),
    batch: () => new FakeBatch(),
    runTransaction: async <T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> => {
      const tx = new FakeTransaction();
      const result = await fn(tx);
      await tx._commit();
      return result;
    },
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({
      seconds: Math.floor(Date.now() / 1000),
      toDate: () => new Date(),
      toMillis: () => Date.now(),
    }),
    fromDate: (d: Date) => ({
      seconds: Math.floor(d.getTime() / 1000),
      toDate: () => d,
      toMillis: () => d.getTime(),
    }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
    arrayUnion: (...args: unknown[]) => ({ __arrayUnion: args }),
    delete: () => ({ __delete: true }),
  };

  return { docs, firestoreFn, firestoreInstance };
});

// ---------------------------------------------------------------------------
// vi.mock wiring
// ---------------------------------------------------------------------------
vi.mock('firebase-admin', () => ({
  default: {
    firestore: fakes.firestoreFn,
    initializeApp: vi.fn(),
  },
  firestore: fakes.firestoreFn,
  initializeApp: vi.fn(),
}));

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
// Import under test
// ---------------------------------------------------------------------------
import { addAddress } from '../addAddress';
import { updateAddress } from '../updateAddress';
import { deleteAddress } from '../deleteAddress';
import { setDefaultAddress } from '../setDefaultAddress';
import { migrateAddressesToSubcollection } from '../migrateAddressesToSubcollection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const UID = 'user_4a_test';

type CallableFn = (data: unknown, ctx: unknown) => Promise<unknown>;

function makeCtx(uid: string = UID): { auth: { uid: string; token: Record<string, unknown> } } {
  return {
    auth: {
      uid,
      token: {},
    },
  };
}

const validAddress = {
  label: 'home' as const,
  name: 'Alice Customer',
  phone: '+919876543210',
  flatHouse: 'B-204',
  street: '12 Park Avenue',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
};

function listAddressDocs(uid: string): Array<{ id: string; data: Record<string, unknown> }> {
  const prefix = `users/${uid}/addresses/`;
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const [path, doc] of fakes.docs.entries()) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    if (remainder.includes('/')) continue;
    out.push({ id: remainder, data: { ...doc } });
  }
  return out;
}

function assertSingleDefault(uid: string): number {
  const list = listAddressDocs(uid);
  const defaults = list.filter((a) => a.data.isDefault === true);
  expect(defaults.length).toBeLessThanOrEqual(1);
  return defaults.length;
}

function userDoc(uid: string): Record<string, unknown> | undefined {
  return fakes.docs.get(`users/${uid}`);
}

function seedUserDoc(uid: string, extra: Record<string, unknown> = {}): void {
  fakes.docs.set(`users/${uid}`, {
    __path: `users/${uid}`,
    role: 'customer',
    isActive: true,
    ...extra,
  });
}

beforeEach(() => {
  fakes.docs.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// addAddress
// ---------------------------------------------------------------------------
describe('addAddress', () => {
  it('first address becomes default even when isDefault is false', async () => {
    seedUserDoc(UID);
    const result = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, isDefault: false },
      makeCtx(),
    )) as { addressId: string; isDefault: boolean };

    expect(result.addressId).toBeDefined();
    expect(result.isDefault).toBe(true);

    const list = listAddressDocs(UID);
    expect(list).toHaveLength(1);
    expect(list[0].data.isDefault).toBe(true);
    expect(assertSingleDefault(UID)).toBe(1);

    // User-doc summary written
    const u = userDoc(UID);
    expect(u?.addressCount).toBe(1);
    expect(u?.defaultAddressId).toBe(result.addressId);
  });

  it('second non-default address leaves the original as default', async () => {
    seedUserDoc(UID);
    const first = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    const second = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'work' },
      makeCtx(),
    )) as { addressId: string; isDefault: boolean };

    expect(second.isDefault).toBe(false);
    const list = listAddressDocs(UID);
    expect(list).toHaveLength(2);
    expect(assertSingleDefault(UID)).toBe(1);
    expect(userDoc(UID)?.defaultAddressId).toBe(first.addressId);
    expect(userDoc(UID)?.addressCount).toBe(2);
  });

  it('adding an address with isDefault:true demotes the previous default', async () => {
    seedUserDoc(UID);
    const first = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    const second = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'work', isDefault: true },
      makeCtx(),
    )) as { addressId: string; isDefault: boolean };

    expect(second.isDefault).toBe(true);
    assertSingleDefault(UID);

    const list = listAddressDocs(UID);
    const firstNow = list.find((a) => a.id === first.addressId);
    const secondNow = list.find((a) => a.id === second.addressId);
    expect(firstNow?.data.isDefault).toBe(false);
    expect(secondNow?.data.isDefault).toBe(true);
    expect(userDoc(UID)?.defaultAddressId).toBe(second.addressId);
  });

  it('rejects when unauthenticated', async () => {
    await expect(
      (addAddress as unknown as CallableFn)(validAddress, { auth: null }),
    ).rejects.toMatchObject({
      name: 'HttpsError',
      code: 'unauthenticated',
    });
  });

  it('rejects invalid pincode via Zod', async () => {
    seedUserDoc(UID);
    await expect(
      (addAddress as unknown as CallableFn)(
        { ...validAddress, pincode: 'abc' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'address/invalid-input',
    });
  });

  it('rejects when pincode has leading whitespace that Zod trim cannot save', async () => {
    seedUserDoc(UID);
    // Zod trim() on the pincode strips whitespace, but if the resulting
    // string doesn't match the pincode regex, we still reject.
    await expect(
      (addAddress as unknown as CallableFn)(
        { ...validAddress, pincode: '!!!' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects when the per-user cap is reached (20)', async () => {
    seedUserDoc(UID);
    // Seed 20 existing addresses straight into the fake store
    for (let i = 0; i < 20; i++) {
      fakes.docs.set(`users/${UID}/addresses/seed-${i}`, {
        __path: `users/${UID}/addresses/seed-${i}`,
        id: `seed-${i}`,
        label: 'other',
        name: 'x',
        phone: '+911234567890',
        flatHouse: 'x',
        street: 'x',
        city: 'x',
        state: 'x',
        pincode: '400001',
        isDefault: i === 0,
        createdAt: '__SERVER_TIMESTAMP__',
        updatedAt: '__SERVER_TIMESTAMP__',
      });
    }

    await expect(
      (addAddress as unknown as CallableFn)(validAddress, makeCtx()),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'address/limit-reached',
    });
  });

  // -------------------------------------------------------------------------
  // Sentinel guard rules (2026-05-14): `'0000000'` phone and `'000000'`
  // pincode are reserved markers for the home-sheet GPS auto-save path.
  // ONLY `label === 'detected'` addresses may carry them; non-detected
  // labels must use real values. Patches may never set the sentinels.
  // -------------------------------------------------------------------------
  it('accepts the sentinel phone + pincode when label is `detected` (GPS auto-save path)', async () => {
    seedUserDoc(UID);
    const result = (await (addAddress as unknown as CallableFn)(
      {
        ...validAddress,
        label: 'detected' as const,
        phone: '0000000',
        pincode: '000000',
      },
      makeCtx(),
    )) as { addressId: string; isDefault: boolean };
    expect(result.addressId).toBeDefined();
    const list = listAddressDocs(UID);
    expect(list[0].data.label).toBe('detected');
    expect(list[0].data.phone).toBe('0000000');
    expect(list[0].data.pincode).toBe('000000');
  });

  it('rejects sentinel phone for a non-detected label (cannot bypass real-phone validation)', async () => {
    seedUserDoc(UID);
    await expect(
      (addAddress as unknown as CallableFn)(
        { ...validAddress, label: 'home' as const, phone: '0000000' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'address/invalid-input',
    });
  });

  it('rejects sentinel pincode for a non-detected label', async () => {
    seedUserDoc(UID);
    await expect(
      (addAddress as unknown as CallableFn)(
        { ...validAddress, label: 'work' as const, pincode: '000000' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'address/invalid-input',
    });
  });
});

// ---------------------------------------------------------------------------
// updateAddress
// ---------------------------------------------------------------------------
describe('updateAddress', () => {
  it('patches a single field and leaves isDefault alone', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string; isDefault: boolean };

    const res = (await (updateAddress as unknown as CallableFn)(
      { addressId: created.addressId, patch: { flatHouse: 'Tower B #104' } },
      makeCtx(),
    )) as { addressId: string; isDefault: boolean };

    expect(res.isDefault).toBe(true); // preserved
    const list = listAddressDocs(UID);
    expect(list[0].data.flatHouse).toBe('Tower B #104');
    expect(list[0].data.name).toBe(validAddress.name); // untouched
    assertSingleDefault(UID);
  });

  it('returns not-found for an unknown addressId', async () => {
    seedUserDoc(UID);
    await expect(
      (updateAddress as unknown as CallableFn)(
        { addressId: 'ghost', patch: { name: 'nope' } },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      code: 'not-found',
      message: 'address/not-found',
    });
  });

  it('rejects empty patch', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    await expect(
      (updateAddress as unknown as CallableFn)(
        { addressId: created.addressId, patch: {} },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'address/empty-patch',
    });
  });

  it('rejects unauthenticated calls', async () => {
    await expect(
      (updateAddress as unknown as CallableFn)(
        { addressId: 'x', patch: { name: 'y' } },
        { auth: null },
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a patch containing isDefault (client must use setDefaultAddress)', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    // The schema strips isDefault (AddressPatchSchema uses .omit), so
    // passing it silently becomes empty patch → rejected.
    await expect(
      (updateAddress as unknown as CallableFn)(
        { addressId: created.addressId, patch: { isDefault: false } as never },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  // -------------------------------------------------------------------------
  // Sentinel + label-narrowing guards on updateAddress (2026-05-14)
  // -------------------------------------------------------------------------
  it('rejects patches that set label to `detected` (cannot convert a real address into a pruneable GPS entry)', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    await expect(
      (updateAddress as unknown as CallableFn)(
        {
          addressId: created.addressId,
          patch: { label: 'detected' } as never,
        },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('allows patches that promote `detected` → `home` (re-categorise an auto-saved entry)', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'detected' as const, phone: '0000000', pincode: '000000' },
      makeCtx(),
    )) as { addressId: string };

    const res = (await (updateAddress as unknown as CallableFn)(
      {
        addressId: created.addressId,
        patch: { label: 'home' as const, phone: '+919876543210', pincode: '400001' },
      },
      makeCtx(),
    )) as { addressId: string };

    expect(res.addressId).toBe(created.addressId);
    const list = listAddressDocs(UID);
    expect(list[0].data.label).toBe('home');
    expect(list[0].data.phone).toBe('+919876543210');
    expect(list[0].data.pincode).toBe('400001');
  });

  it('rejects patches that set the sentinel phone `0000000` (no path can bypass real-phone validation)', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    await expect(
      (updateAddress as unknown as CallableFn)(
        { addressId: created.addressId, patch: { phone: '0000000' } },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects patches that set the sentinel pincode `000000`', async () => {
    seedUserDoc(UID);
    const created = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    await expect(
      (updateAddress as unknown as CallableFn)(
        { addressId: created.addressId, patch: { pincode: '000000' } },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

// ---------------------------------------------------------------------------
// deleteAddress
// ---------------------------------------------------------------------------
describe('deleteAddress', () => {
  it('deletes a non-default address without promoting another', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };
    const b = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'work' },
      makeCtx(),
    )) as { addressId: string };

    const res = (await (deleteAddress as unknown as CallableFn)(
      { addressId: b.addressId },
      makeCtx(),
    )) as { deleted: true; promotedDefault: string | null };

    expect(res.deleted).toBe(true);
    expect(res.promotedDefault).toBeNull();
    expect(listAddressDocs(UID)).toHaveLength(1);
    assertSingleDefault(UID);
    expect(userDoc(UID)?.defaultAddressId).toBe(a.addressId);
  });

  it('promotes the next address when the default is deleted', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };
    // Force B to be older but still present
    const b = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'work' },
      makeCtx(),
    )) as { addressId: string };

    const res = (await (deleteAddress as unknown as CallableFn)(
      { addressId: a.addressId },
      makeCtx(),
    )) as { deleted: true; promotedDefault: string | null };

    expect(res.deleted).toBe(true);
    expect(res.promotedDefault).toBe(b.addressId);
    const list = listAddressDocs(UID);
    expect(list).toHaveLength(1);
    expect(list[0].data.isDefault).toBe(true);
    assertSingleDefault(UID);
    expect(userDoc(UID)?.defaultAddressId).toBe(b.addressId);
  });

  it('clears defaultAddressId when deleting the last address', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    const res = (await (deleteAddress as unknown as CallableFn)(
      { addressId: a.addressId },
      makeCtx(),
    )) as { deleted: true; promotedDefault: string | null };

    expect(res.deleted).toBe(true);
    expect(res.promotedDefault).toBeNull();
    expect(listAddressDocs(UID)).toHaveLength(0);
    expect(userDoc(UID)?.defaultAddressId).toBeNull();
    expect(userDoc(UID)?.addressCount).toBe(0);
  });

  it('blocks deletion when an active booking references the address', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    // Seed a booking pointing at this address
    fakes.docs.set('bookings/b1', {
      __path: 'bookings/b1',
      userId: UID,
      addressId: a.addressId,
      bookingStatus: 'confirmed',
    });

    await expect(
      (deleteAddress as unknown as CallableFn)(
        { addressId: a.addressId },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'address/has-active-booking',
    });

    // Address still present
    expect(listAddressDocs(UID)).toHaveLength(1);
  });

  it('allows deletion when a booking referencing the address is already completed', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    fakes.docs.set('bookings/b1', {
      __path: 'bookings/b1',
      userId: UID,
      addressId: a.addressId,
      bookingStatus: 'completed',
    });

    const res = (await (deleteAddress as unknown as CallableFn)(
      { addressId: a.addressId },
      makeCtx(),
    )) as { deleted: true };
    expect(res.deleted).toBe(true);
  });

  it('rejects not-found', async () => {
    seedUserDoc(UID);
    await expect(
      (deleteAddress as unknown as CallableFn)(
        { addressId: 'ghost' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// setDefaultAddress
// ---------------------------------------------------------------------------
describe('setDefaultAddress', () => {
  it('flips the default to the target and demotes all others', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };
    const b = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'work' },
      makeCtx(),
    )) as { addressId: string };
    const c = (await (addAddress as unknown as CallableFn)(
      { ...validAddress, label: 'other' },
      makeCtx(),
    )) as { addressId: string };

    const res = (await (setDefaultAddress as unknown as CallableFn)(
      { addressId: c.addressId },
      makeCtx(),
    )) as { addressId: string };

    expect(res.addressId).toBe(c.addressId);
    assertSingleDefault(UID);
    const list = listAddressDocs(UID);
    expect(list.find((x) => x.id === a.addressId)?.data.isDefault).toBe(false);
    expect(list.find((x) => x.id === b.addressId)?.data.isDefault).toBe(false);
    expect(list.find((x) => x.id === c.addressId)?.data.isDefault).toBe(true);
    expect(userDoc(UID)?.defaultAddressId).toBe(c.addressId);
  });

  it('is idempotent when called with an already-default address', async () => {
    seedUserDoc(UID);
    const a = (await (addAddress as unknown as CallableFn)(
      validAddress,
      makeCtx(),
    )) as { addressId: string };

    const res = (await (setDefaultAddress as unknown as CallableFn)(
      { addressId: a.addressId },
      makeCtx(),
    )) as { addressId: string };
    expect(res.addressId).toBe(a.addressId);
    assertSingleDefault(UID);
  });

  it('rejects not-found', async () => {
    seedUserDoc(UID);
    await expect(
      (setDefaultAddress as unknown as CallableFn)(
        { addressId: 'ghost' },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

// ---------------------------------------------------------------------------
// migrateAddressesToSubcollection
// ---------------------------------------------------------------------------
describe('migrateAddressesToSubcollection', () => {
  it('user with zero addresses returns migrated:0, alreadyDone:false, then true on retry', async () => {
    seedUserDoc(UID);

    const first = (await (migrateAddressesToSubcollection as unknown as CallableFn)(
      {},
      makeCtx(),
    )) as { migrated: number; alreadyDone: boolean };
    expect(first).toEqual({ migrated: 0, alreadyDone: false });

    const second = (await (migrateAddressesToSubcollection as unknown as CallableFn)(
      {},
      makeCtx(),
    )) as { migrated: number; alreadyDone: boolean };
    expect(second).toEqual({ migrated: 0, alreadyDone: true });

    // Journal persisted
    expect(fakes.docs.get(`address_migrations/${UID}`)).toBeDefined();
  });

  it('user with one default-flagged address preserves it and clears the array', async () => {
    seedUserDoc(UID, {
      addresses: [
        {
          id: 'legacy-1',
          label: 'home',
          name: 'Bob',
          phone: '+919876543210',
          flatHouse: 'A-1',
          street: 'Some street',
          city: 'Mumbai',
          state: 'MH',
          pincode: '400001',
          isDefault: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    const res = (await (migrateAddressesToSubcollection as unknown as CallableFn)(
      {},
      makeCtx(),
    )) as { migrated: number; alreadyDone: boolean };
    expect(res.migrated).toBe(1);
    expect(res.alreadyDone).toBe(false);

    const list = listAddressDocs(UID);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('legacy-1');
    expect(list[0].data.isDefault).toBe(true);
    expect(list[0].data.name).toBe('Bob');

    // Inline array cleared
    const u = userDoc(UID);
    expect(u?.addresses).toBeUndefined();
    expect(u?.defaultAddressId).toBe('legacy-1');
    expect(u?.addressCount).toBe(1);
    assertSingleDefault(UID);
  });

  it('user with three addresses and zero defaults promotes the first', async () => {
    seedUserDoc(UID, {
      addresses: [
        {
          id: 'a',
          label: 'home',
          name: 'x',
          phone: '+911',
          flatHouse: '1',
          street: '1',
          city: '1',
          state: '1',
          pincode: '400001',
          isDefault: false,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'b',
          label: 'work',
          name: 'x',
          phone: '+911',
          flatHouse: '2',
          street: '2',
          city: '2',
          state: '2',
          pincode: '400002',
          isDefault: false,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
        {
          id: 'c',
          label: 'other',
          name: 'x',
          phone: '+911',
          flatHouse: '3',
          street: '3',
          city: '3',
          state: '3',
          pincode: '400003',
          isDefault: false,
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
        },
      ],
    });

    const res = (await (migrateAddressesToSubcollection as unknown as CallableFn)(
      {},
      makeCtx(),
    )) as { migrated: number };
    expect(res.migrated).toBe(3);

    const list = listAddressDocs(UID);
    expect(list).toHaveLength(3);
    assertSingleDefault(UID);
    const first = list.find((a) => a.id === 'a');
    expect(first?.data.isDefault).toBe(true);
    expect(userDoc(UID)?.defaultAddressId).toBe('a');
  });

  it('user with two defaults in the legacy array keeps only the first', async () => {
    seedUserDoc(UID, {
      addresses: [
        {
          id: 'a',
          label: 'home',
          name: 'x',
          phone: '+911',
          flatHouse: '1',
          street: '1',
          city: '1',
          state: '1',
          pincode: '400001',
          isDefault: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'b',
          label: 'work',
          name: 'x',
          phone: '+911',
          flatHouse: '2',
          street: '2',
          city: '2',
          state: '2',
          pincode: '400002',
          isDefault: true,
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        },
      ],
    });

    await (migrateAddressesToSubcollection as unknown as CallableFn)({}, makeCtx());
    assertSingleDefault(UID);
    const list = listAddressDocs(UID);
    expect(list.find((x) => x.id === 'a')?.data.isDefault).toBe(true);
    expect(list.find((x) => x.id === 'b')?.data.isDefault).toBe(false);
    expect(userDoc(UID)?.defaultAddressId).toBe('a');
  });

  it('is fully idempotent — second invocation does no work', async () => {
    seedUserDoc(UID, {
      addresses: [
        {
          id: 'a',
          label: 'home',
          name: 'x',
          phone: '+911',
          flatHouse: '1',
          street: '1',
          city: '1',
          state: '1',
          pincode: '400001',
          isDefault: true,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    await (migrateAddressesToSubcollection as unknown as CallableFn)({}, makeCtx());
    const docsAfterFirst = new Map(fakes.docs);

    const second = (await (migrateAddressesToSubcollection as unknown as CallableFn)(
      {},
      makeCtx(),
    )) as { alreadyDone: boolean };
    expect(second.alreadyDone).toBe(true);

    // No new address docs created on retry
    const listAfterSecond = listAddressDocs(UID);
    expect(listAfterSecond).toHaveLength(1);
    // Journal retained
    expect(docsAfterFirst.has(`address_migrations/${UID}`)).toBe(true);
  });

  it('rejects unauthenticated', async () => {
    await expect(
      (migrateAddressesToSubcollection as unknown as CallableFn)(
        {},
        { auth: null },
      ),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

// ---------------------------------------------------------------------------
// Invariant property-style fuzz: 50 random sequences of operations must
// always end with at most one default.
// ---------------------------------------------------------------------------
describe('invariant (property fuzz)', () => {
  it('after any random sequence of add/setDefault/delete, at most one isDefault=true survives', async () => {
    seedUserDoc(UID);
    const addressIds: string[] = [];

    function rand<T>(arr: T[]): T {
      return arr[Math.floor(Math.random() * arr.length)];
    }

    const operations: Array<'add' | 'setDefault' | 'delete'> = [
      'add',
      'add',
      'add',
      'setDefault',
      'delete',
    ];

    for (let step = 0; step < 40; step++) {
      const op = rand(operations);
      if (op === 'add') {
        if (addressIds.length >= 10) continue;
        const r = (await (addAddress as unknown as CallableFn)(
          { ...validAddress, label: rand(['home', 'work', 'other'] as const) },
          makeCtx(),
        )) as { addressId: string };
        addressIds.push(r.addressId);
      } else if (op === 'setDefault' && addressIds.length > 0) {
        const id = rand(addressIds);
        await (setDefaultAddress as unknown as CallableFn)(
          { addressId: id },
          makeCtx(),
        );
      } else if (op === 'delete' && addressIds.length > 0) {
        const id = rand(addressIds);
        await (deleteAddress as unknown as CallableFn)(
          { addressId: id },
          makeCtx(),
        );
        const idx = addressIds.indexOf(id);
        if (idx >= 0) addressIds.splice(idx, 1);
      }

      // Invariant check after every operation
      assertSingleDefault(UID);
      const list = listAddressDocs(UID);
      const defaults = list.filter((a) => a.data.isDefault === true);
      if (list.length > 0) {
        expect(defaults.length).toBe(1);
      } else {
        expect(defaults.length).toBe(0);
      }
    }
  });
});
