/**
 * mergeUserAccounts — emulator-driven callable tests.
 *
 * Same shimming strategy as `applyVoucher.test.ts`: keep `firebase-admin`
 * real (so all reads/writes hit the live Firestore emulator), shim
 * `firebase-functions.https.onCall` to identity, and pass through
 * `withRateLimit` per the rate-limiter mock cascade memo.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Emulator reachability probe — when run via vanilla `npm test` (no emulator)
// this suite would hang on `clearCollection` calls; gate on a short HTTP
// probe and short-circuit to `describe.skip` when the Firestore emulator
// isn't reachable.
// ---------------------------------------------------------------------------

async function isFirestoreEmulatorReachable(): Promise<boolean> {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8080';
  try {
    const res = await fetch(`http://${host}/`);
    return res.status < 500;
  } catch {
    return false;
  }
}

const emulatorAvailable = await isFirestoreEmulatorReachable();
const describeIfEmulator = emulatorAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Mocks (must come before importing the callable under test)
// ---------------------------------------------------------------------------

vi.mock('firebase-functions', async () => {
  const actual = await vi.importActual<typeof import('firebase-functions')>('firebase-functions');
  const httpsShim = {
    ...actual.https,
    onCall: (handler: unknown) => handler,
  };
  const runWithShim = (_opts?: unknown) => ({
    https: httpsShim,
    region: () => ({ https: httpsShim }),
  });
  return {
    ...actual,
    runWith: runWithShim,
    https: httpsShim,
    default: { ...actual, runWith: runWithShim, https: httpsShim },
  };
});

vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: <TData, TResult>(
    _opts: unknown,
    handler: (data: TData, ctx: unknown) => Promise<TResult>,
  ) => handler,
}));

// ---------------------------------------------------------------------------
// Real firebase-admin connected to the emulator
// ---------------------------------------------------------------------------
//
// IMPORTANT — emulator-host + initializeApp must run BEFORE the callable is
// imported, because `../callable/mergeUserAccounts` calls `admin.firestore()`
// at module-load time. ESM hoists static `import` statements above runtime
// code, so the callable is loaded via dynamic `await import()` from inside
// `beforeAll` to guarantee correct ordering.

import * as admin from 'firebase-admin';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
}
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'demo-glamornate-rules-test' });
}
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Import under test (after mocks + admin init — loaded dynamically below)
// ---------------------------------------------------------------------------

type CallableHandler = (
  data: unknown,
  context: { auth?: { uid: string } },
) => Promise<{
  success: boolean;
  primaryUid: string;
  secondaryUid: string;
  counters: Record<string, number>;
}>;

let handler: CallableHandler;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_UID = 'merge-admin-uid';
const NON_ADMIN_UID = 'merge-non-admin-uid';
const PRIMARY_UID = 'merge-primary-uid';
const SECONDARY_UID = 'merge-secondary-uid';

async function clearCollection(name: string): Promise<void> {
  const snap = await db.collection(name).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

async function seedUsers(opts: { withAdmin?: boolean; withPrimary?: boolean; withSecondary?: boolean; withNonAdmin?: boolean } = {}): Promise<void> {
  const {
    withAdmin = true,
    withPrimary = true,
    withSecondary = true,
    withNonAdmin = false,
  } = opts;
  const ops: Promise<unknown>[] = [];
  if (withAdmin) {
    ops.push(
      db.collection('users').doc(ADMIN_UID).set({
        role: 'admin',
        isActive: true,
        email: 'admin@example.com',
      }),
    );
  }
  if (withNonAdmin) {
    ops.push(
      db.collection('users').doc(NON_ADMIN_UID).set({
        role: 'customer',
        isActive: true,
        email: 'customer@example.com',
      }),
    );
  }
  if (withPrimary) {
    ops.push(
      db.collection('users').doc(PRIMARY_UID).set({
        role: 'customer',
        isActive: true,
        email: 'primary@example.com',
      }),
    );
  }
  if (withSecondary) {
    ops.push(
      db.collection('users').doc(SECONDARY_UID).set({
        role: 'customer',
        isActive: true,
        email: 'secondary@example.com',
      }),
    );
  }
  await Promise.all(ops);
}

async function seedBookingsForSecondary(count: number): Promise<string[]> {
  const ids: string[] = [];
  const batch = db.batch();
  for (let i = 0; i < count; i += 1) {
    const id = `merge-booking-${i}`;
    ids.push(id);
    batch.set(db.collection('bookings').doc(id), {
      userId: SECONDARY_UID,
      spaId: 'spa-merge',
      bookingStatus: 'confirmed',
    });
  }
  await batch.commit();
  return ids;
}

const validInput = () => ({
  primaryUid: PRIMARY_UID,
  secondaryUid: SECONDARY_UID,
  reason: 'Customer confirmed both accounts via support ticket #1234',
});

const ctx = (uid: string) => ({ auth: { uid } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfEmulator('mergeUserAccounts (emulator)', () => {
  beforeAll(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    }
    const mod = await import('../callable/mergeUserAccounts');
    handler = mod.mergeUserAccounts as unknown as CallableHandler;
  });

  beforeEach(async () => {
    await Promise.all([
      clearCollection('users'),
      clearCollection('bookings'),
      clearCollection('notifications'),
      clearCollection('audit_logs'),
    ]);
  });

  // Intentionally NOT calling `admin.app().delete()` here. Vitest runs all
  // suites against the same firebase-admin singleton; tearing down the app
  // in afterAll cascades and breaks any test file that loads later in the
  // run, because the callable's module-level `admin.firestore()` binding
  // can't reattach to a deleted app.

  it('admin caller reassigns 3 bookings to the primary uid and soft-deletes the secondary user', async () => {
    await seedUsers();
    const bookingIds = await seedBookingsForSecondary(3);

    const result = await handler(validInput(), ctx(ADMIN_UID));

    expect(result.success).toBe(true);
    expect(result.primaryUid).toBe(PRIMARY_UID);
    expect(result.counters.bookings).toBe(3);

    for (const id of bookingIds) {
      const snap = await db.collection('bookings').doc(id).get();
      const data = snap.data()!;
      expect(data.userId).toBe(PRIMARY_UID);
      expect(data._mergedFrom).toBe(SECONDARY_UID);
    }

    const secondarySnap = await db.collection('users').doc(SECONDARY_UID).get();
    const secondary = secondarySnap.data()!;
    expect(secondary.role).toBe('_merged');
    expect(secondary.mergedInto).toBe(PRIMARY_UID);
    expect(secondary.isActive).toBe(false);
  });

  it('non-admin caller is rejected with permission-denied', async () => {
    await seedUsers({ withNonAdmin: true });

    await expect(handler(validInput(), ctx(NON_ADMIN_UID))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('rejects invalid-argument with SAME_UID when primaryUid === secondaryUid', async () => {
    await seedUsers();

    await expect(
      handler(
        { ...validInput(), secondaryUid: PRIMARY_UID },
        ctx(ADMIN_UID),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      details: { error: 'SAME_UID' },
    });
  });

  it('rejects not-found with USER_NOT_FOUND when the primary user is missing', async () => {
    await seedUsers({ withPrimary: false });

    await expect(handler(validInput(), ctx(ADMIN_UID))).rejects.toMatchObject({
      code: 'not-found',
      details: { error: 'USER_NOT_FOUND' },
    });
  });

  it('rejects not-found with USER_NOT_FOUND when the secondary user is missing', async () => {
    await seedUsers({ withSecondary: false });

    await expect(handler(validInput(), ctx(ADMIN_UID))).rejects.toMatchObject({
      code: 'not-found',
      details: { error: 'USER_NOT_FOUND' },
    });
  });
});
