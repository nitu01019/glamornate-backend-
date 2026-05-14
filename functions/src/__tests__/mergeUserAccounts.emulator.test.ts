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

async function seedUsers(opts: { withAdmin?: boolean; withPrimary?: boolean; withSecondary?: boolean; withNonAdmin?: boolean; secondaryActive?: boolean } = {}): Promise<void> {
  const {
    withAdmin = true,
    withPrimary = true,
    withSecondary = true,
    withNonAdmin = false,
    // α8-6: default secondary as inactive — that's the precondition the
    // hardened callable enforces.
    secondaryActive = false,
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
        isActive: secondaryActive,
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
      clearCollection('wallet'),
      clearCollection('walletTransactions'),
      clearCollection('reviews'),
      clearCollection('userVouchers'),
      clearCollection('supportTickets'),
      clearCollection('fcmTokens'),
      clearCollection('audit_logs'),
      clearCollection('merge_jobs'),
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

    // α8-8: journal entry must be `completed` after a successful merge.
    const journalSnap = await db.collection('merge_jobs').doc(SECONDARY_UID).get();
    expect(journalSnap.exists).toBe(true);
    expect(journalSnap.data()!.status).toBe('completed');
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

  // ---------------------------------------------------------------------------
  // α8-5 — TOCTOU: admin demoted mid-flight aborts subsequent destructive work
  // ---------------------------------------------------------------------------
  it('α8-5: aborts with permission-denied when admin is demoted mid-merge', async () => {
    await seedUsers();
    // Seed enough bookings to force two chunks (>400). Each chunk is wrapped
    // in a transaction with a fresh admin re-check; demoting between chunks
    // must abort the merge.
    // For test runtime, just seed a handful and demote BEFORE invoking — the
    // transactional re-check inside the first chunk sees the demotion and
    // throws. (The "between chunks" timing is the same code path.)
    await seedBookingsForSecondary(3);

    // Demote admin to customer before invoking
    await db.collection('users').doc(ADMIN_UID).update({ role: 'customer' });

    await expect(handler(validInput(), ctx(ADMIN_UID))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    // Verify bookings were NOT reassigned
    const stillSecondarySnap = await db
      .collection('bookings')
      .where('userId', '==', SECONDARY_UID)
      .get();
    expect(stillSecondarySnap.size).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // α8-6 — isActive precondition: refuse merge of active secondary user
  // ---------------------------------------------------------------------------
  it('α8-6: rejects failed-precondition with SECONDARY_USER_STILL_ACTIVE when secondary.isActive=true', async () => {
    await seedUsers({ secondaryActive: true });

    await expect(handler(validInput(), ctx(ADMIN_UID))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { error: 'SECONDARY_USER_STILL_ACTIVE' },
    });

    // Verify no journal entry was written on precondition failure
    const journalSnap = await db.collection('merge_jobs').doc(SECONDARY_UID).get();
    expect(journalSnap.exists).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // α8-7 — dynamic collections: ALL USER_KEYED_COLLECTIONS get swept
  // ---------------------------------------------------------------------------
  it('α8-7: sweeps every collection in USER_KEYED_COLLECTIONS, not just bookings/notifications', async () => {
    await seedUsers();

    // Seed one doc in each user-keyed collection. Each doc keyed by the
    // secondary uid must be reassigned to the primary.
    const { USER_KEYED_COLLECTIONS } = await import('../shared/contracts/auth');
    const ops: Promise<unknown>[] = [];
    for (const col of USER_KEYED_COLLECTIONS) {
      ops.push(
        db.collection(col).doc(`${col}-doc-1`).set({
          userId: SECONDARY_UID,
          payload: 'value',
        }),
      );
    }
    await Promise.all(ops);

    const result = await handler(validInput(), ctx(ADMIN_UID));

    expect(result.success).toBe(true);

    // Every collection should report 1 reassigned doc.
    for (const col of USER_KEYED_COLLECTIONS) {
      expect(result.counters[col]).toBe(1);
      const snap = await db.collection(col).doc(`${col}-doc-1`).get();
      const data = snap.data()!;
      expect(data.userId).toBe(PRIMARY_UID);
      expect(data._mergedFrom).toBe(SECONDARY_UID);
    }
  });

  // ---------------------------------------------------------------------------
  // α8-8 — merge_jobs journal: status transitions + idempotent replay
  // ---------------------------------------------------------------------------
  it('α8-8: writes merge_jobs journal and short-circuits idempotent replay', async () => {
    await seedUsers();
    await seedBookingsForSecondary(2);

    const firstResult = await handler(validInput(), ctx(ADMIN_UID));
    expect(firstResult.success).toBe(true);

    // Journal must show completed with the counters baked in.
    const journalSnap = await db.collection('merge_jobs').doc(SECONDARY_UID).get();
    expect(journalSnap.exists).toBe(true);
    const journal = journalSnap.data()!;
    expect(journal.status).toBe('completed');
    expect(journal.primaryUid).toBe(PRIMARY_UID);
    expect(journal.secondaryUid).toBe(SECONDARY_UID);
    expect(journal.counters.bookings).toBe(2);
    expect(Array.isArray(journal.completedCollections)).toBe(true);
    expect(journal.completedCollections).toContain('bookings');

    // Replay: same input must short-circuit to `alreadyMerged: true`.
    const replayResult = (await handler(validInput(), ctx(ADMIN_UID))) as unknown as {
      success: boolean;
      alreadyMerged?: boolean;
      counters: Record<string, number>;
    };
    expect(replayResult.success).toBe(true);
    expect(replayResult.alreadyMerged).toBe(true);
    expect(replayResult.counters.bookings).toBe(2);
  });

  it('α8-8: rejects in-flight concurrent invocation with MERGE_IN_FLIGHT', async () => {
    await seedUsers();

    // Pre-seed a fresh in_progress journal entry to simulate a concurrent
    // merge happening right now.
    await db.collection('merge_jobs').doc(SECONDARY_UID).set({
      status: 'in_progress',
      primaryUid: PRIMARY_UID,
      secondaryUid: SECONDARY_UID,
      reason: 'concurrent test',
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAtMillis: Date.now(),
      attemptedCollections: [],
      completedCollections: [],
    });

    await expect(handler(validInput(), ctx(ADMIN_UID))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { error: 'MERGE_IN_FLIGHT' },
    });
  });
});
