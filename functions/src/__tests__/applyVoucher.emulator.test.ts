/**
 * applyVoucher — emulator-driven callable tests.
 *
 * Strategy: keep `firebase-admin` real (so the callable's `db.runTransaction`,
 * `txn.update`, `FieldValue.increment`, etc. all execute against the live
 * Firestore emulator started by `npm run test:emulator`). We only shim:
 *   1. `firebase-functions.https.onCall` -> identity, so the exported
 *      callable is directly invokable as `(data, context) => Promise<T>`.
 *   2. `withRateLimit` -> pass-through, per the project-wide rate-limiter
 *      mock cascade memo (every callable test must do this or the wrapper
 *      blocks before reaching our seeded data).
 *
 * The Firestore emulator host is set by `firebase emulators:exec` before
 * Vitest is invoked (FIRESTORE_EMULATOR_HOST=localhost:8080 by default,
 * matching backend/firebase.json).
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

// `firebase-functions` -> keep HttpsError real, shim onCall to identity.
vi.mock('firebase-functions', async () => {
  const actual = await vi.importActual<typeof import('firebase-functions')>('firebase-functions');
  // Build a runWith().https.onCall pipeline that returns the inner handler.
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

// `withRateLimit` -> pass-through so the inner handler runs unmolested.
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
// IMPORTANT — emulator-host + initializeApp must be set BEFORE the callable
// is imported, because `../callable/applyVoucher` calls `admin.firestore()`
// at module-load time. ESM hoists static `import` statements above runtime
// statements, so we set `FIRESTORE_EMULATOR_HOST` and `initializeApp()` here
// (top of file) and load the callable via dynamic `await import()` inside
// `beforeAll` to guarantee correct ordering.

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

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
) => Promise<{ success: boolean; voucherCode: string; discount: number; alreadyApplied: boolean }>;

let handler: CallableHandler;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'apply-voucher-user-1';
const OTHER_USER_ID = 'apply-voucher-user-2';
const BOOKING_ID = 'apply-voucher-booking-1';
const VOUCHER_CODE = 'TESTCODE';

async function clearCollection(name: string): Promise<void> {
  const snap = await db.collection(name).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

async function clearVoucherSubcollections(): Promise<void> {
  const voucherRef = db.collection('vouchers').doc(VOUCHER_CODE);
  const redemptions = await voucherRef.collection('redemptions').get();
  if (!redemptions.empty) {
    const batch = db.batch();
    for (const doc of redemptions.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

interface SeedVoucherOpts {
  discountPercent?: number;
  discountAmount?: number;
  maxDiscount?: number;
  maxRedemptions?: number;
  redeemedCount?: number;
  isActive?: boolean;
  expiresAtMs?: number | null;
}

async function seedVoucher(opts: SeedVoucherOpts = {}): Promise<void> {
  const {
    discountPercent = 10,
    discountAmount,
    maxDiscount,
    maxRedemptions,
    redeemedCount = 0,
    isActive = true,
    expiresAtMs,
  } = opts;
  const data: Record<string, unknown> = {
    code: VOUCHER_CODE,
    isActive,
    redeemedCount,
  };
  if (typeof discountAmount === 'number') data.discountAmount = discountAmount;
  else data.discountPercent = discountPercent;
  if (typeof maxDiscount === 'number') data.maxDiscount = maxDiscount;
  if (typeof maxRedemptions === 'number') data.maxRedemptions = maxRedemptions;
  if (typeof expiresAtMs === 'number') {
    data.expiresAt = admin.firestore.Timestamp.fromMillis(expiresAtMs);
  }
  await db.collection('vouchers').doc(VOUCHER_CODE).set(data);
}

interface SeedBookingOpts {
  userId?: string;
  bookingStatus?: string;
  services?: number;
  addons?: number;
  tax?: number;
  platformFee?: number;
}

async function seedBooking(opts: SeedBookingOpts = {}): Promise<void> {
  const {
    userId = USER_ID,
    bookingStatus = 'confirmed',
    services = 1000,
    addons = 0,
    tax = 0,
    platformFee = 0,
  } = opts;
  await db
    .collection('bookings')
    .doc(BOOKING_ID)
    .set({
      userId,
      bookingStatus,
      pricing: {
        services,
        addons,
        tax,
        platformFee,
        discount: 0,
        total: services + addons + tax + platformFee,
      },
    });
}

function ctx(uid: string = USER_ID) {
  return { auth: { uid } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfEmulator('applyVoucher (emulator)', () => {
  beforeAll(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    }
    const mod = await import('../callable/applyVoucher');
    handler = mod.applyVoucher as unknown as CallableHandler;
  });

  beforeEach(async () => {
    await Promise.all([
      clearCollection('bookings'),
      clearCollection('vouchers'),
      clearCollection('audit_logs'),
    ]);
    await clearVoucherSubcollections();
  });

  // Intentionally NOT calling `admin.app().delete()` here. Vitest runs all
  // suites against the same firebase-admin singleton; tearing down the app
  // in afterAll cascades and breaks any test file that loads later in the
  // run, because the callable's module-level `admin.firestore()` binding
  // can't reattach to a deleted app.

  it('happy path: applies a 10% discount to a 1000-rupee subtotal', async () => {
    await seedVoucher({ discountPercent: 10, maxRedemptions: 5 });
    await seedBooking({ services: 1000 });

    const result = await handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx());

    expect(result.success).toBe(true);
    expect(result.discount).toBe(100);
    expect(result.alreadyApplied).toBe(false);

    const bookingSnap = await db.collection('bookings').doc(BOOKING_ID).get();
    const booking = bookingSnap.data()!;
    expect(booking.pricing.discount).toBe(100);
    expect(booking.voucherCode).toBe(VOUCHER_CODE);

    const voucherSnap = await db.collection('vouchers').doc(VOUCHER_CODE).get();
    expect(voucherSnap.data()?.redeemedCount).toBe(1);
  });

  it('idempotent: re-applying the same code returns alreadyApplied=true and does not increment redeemedCount', async () => {
    await seedVoucher({ discountPercent: 10, maxRedemptions: 5 });
    await seedBooking({ services: 1000 });

    await handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx());
    const second = await handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx());

    expect(second.alreadyApplied).toBe(true);

    const voucherSnap = await db.collection('vouchers').doc(VOUCHER_CODE).get();
    expect(voucherSnap.data()?.redeemedCount).toBe(1);
  });

  it('throws not-found with VOUCHER_NOT_FOUND when the voucher does not exist', async () => {
    await seedBooking();

    await expect(
      handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx()),
    ).rejects.toMatchObject({
      code: 'not-found',
      details: { error: 'VOUCHER_NOT_FOUND' },
    });
  });

  it('throws failed-precondition with VOUCHER_EXPIRED when expiresAt is in the past', async () => {
    await seedVoucher({
      discountPercent: 10,
      maxRedemptions: 5,
      expiresAtMs: Date.now() - 24 * 60 * 60 * 1000,
    });
    await seedBooking();

    await expect(
      handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx()),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { error: 'VOUCHER_EXPIRED' },
    });
  });

  it('throws failed-precondition with VOUCHER_LIMIT_REACHED when redeemedCount >= maxRedemptions', async () => {
    await seedVoucher({ discountPercent: 10, maxRedemptions: 5, redeemedCount: 5 });
    await seedBooking();

    await expect(
      handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx()),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { error: 'VOUCHER_LIMIT_REACHED' },
    });
  });

  it('throws permission-denied when the booking is owned by a different user', async () => {
    await seedVoucher({ discountPercent: 10, maxRedemptions: 5 });
    await seedBooking({ userId: OTHER_USER_ID });

    await expect(
      handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx(USER_ID)),
    ).rejects.toBeInstanceOf(functions.https.HttpsError);

    await expect(
      handler({ bookingId: BOOKING_ID, code: VOUCHER_CODE }, ctx(USER_ID)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
