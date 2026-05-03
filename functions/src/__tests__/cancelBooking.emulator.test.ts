/**
 * cancelBooking — emulator-driven callable tests (Phase 1, 2026-05-02 rewrite).
 *
 * The pre-Phase-1 suite tested a refund-percentage matrix that has been
 * removed: pay-at-spa is the only mode, so there is no online amount to
 * refund. This rewrite covers the post-Phase-1 contract:
 *
 *   - successful cancellation flips bookingStatus -> 'cancelled' and
 *     releases the held availability slot atomically;
 *   - return shape is { success, refundAmount: null, currency };
 *   - permission, status-eligibility, and actor-tagging behaviour.
 *
 * Mocking strategy mirrors the other emulator-backed callable tests in
 * this directory:
 *   - `firebase-functions.https.onCall` -> identity (so the exported
 *     callable is directly invokable);
 *   - `withRateLimit` -> pass-through (per the rate-limiter mock cascade
 *     memo — every callable test must do this);
 *   - `firebase-admin` is left real so reads/writes hit the live
 *     Firestore emulator.
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
// imported, because `../callable/cancelBooking` invokes `admin.firestore()`
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
) => Promise<{ success: boolean; refundAmount: number | null; currency: string }>;

let handler: CallableHandler;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER_UID = 'cancel-booking-customer-1';
const OTHER_CUSTOMER_UID = 'cancel-booking-customer-2';
const SPA_OWNER_UID = 'cancel-booking-spa-owner-1';
const SPA_ID = 'cancel-booking-spa-1';
const THERAPIST_ID = 'cancel-booking-therapist-1';
const BOOKING_ID = 'cancel-booking-id-1';
const SLOT_DATE = '2026-06-15';
const SLOT_START = '10:00';
const SLOT_END = '11:00';
const AVAILABILITY_DOC_ID = `${SPA_ID}_${SLOT_DATE}_${THERAPIST_ID}`;

async function clearCollection(name: string): Promise<void> {
  const snap = await db.collection(name).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

interface SeedBookingOpts {
  userId?: string;
  bookingStatus?: string;
}

async function seedBooking(opts: SeedBookingOpts = {}): Promise<void> {
  const { userId = CUSTOMER_UID, bookingStatus = 'confirmed' } = opts;
  await db
    .collection('bookings')
    .doc(BOOKING_ID)
    .set({
      userId,
      spaId: SPA_ID,
      therapistId: THERAPIST_ID,
      bookingStatus,
      slot: { date: SLOT_DATE, start: SLOT_START, end: SLOT_END },
      pricing: { services: 1000, addons: 0, tax: 0, platformFee: 0, total: 1000, currency: 'INR' },
      statusHistory: [],
    });
}

async function seedAvailabilityHoldingSlot(): Promise<void> {
  await db
    .collection('availability')
    .doc(AVAILABILITY_DOC_ID)
    .set({
      spaId: SPA_ID,
      therapistId: THERAPIST_ID,
      date: SLOT_DATE,
      slots: [
        {
          start: SLOT_START,
          end: SLOT_END,
          available: false,
          bookingId: BOOKING_ID,
        },
      ],
    });
}

async function seedUser(uid: string, role: string, spaId?: string): Promise<void> {
  const data: Record<string, unknown> = { role, isActive: true };
  if (spaId) data.spaData = { spaId };
  await db.collection('users').doc(uid).set(data);
}

const ctx = (uid: string) => ({ auth: { uid } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfEmulator('cancelBooking (emulator)', () => {
  beforeAll(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    }
    const mod = await import('../callable/cancelBooking');
    handler = mod.cancelBooking as unknown as CallableHandler;
  });

  beforeEach(async () => {
    await Promise.all([
      clearCollection('bookings'),
      clearCollection('availability'),
      clearCollection('users'),
      clearCollection('audit_logs'),
    ]);
  });

  // Intentionally NOT calling `admin.app().delete()` here. Vitest runs all
  // suites against the same firebase-admin singleton; tearing down the app
  // in afterAll cascades and breaks any test file that loads later in the
  // run, because the callable's module-level `admin.firestore()` binding
  // can't reattach to a deleted app.

  it('customer cancels own confirmed booking: succeeds, refundAmount=null, status flips, slot is released', async () => {
    await seedUser(CUSTOMER_UID, 'customer');
    await seedBooking();
    await seedAvailabilityHoldingSlot();

    const result = await handler(
      { bookingId: BOOKING_ID, reason: 'changed plans' },
      ctx(CUSTOMER_UID),
    );

    expect(result.success).toBe(true);
    expect(result.refundAmount).toBeNull();

    const bookingSnap = await db.collection('bookings').doc(BOOKING_ID).get();
    const booking = bookingSnap.data()!;
    expect(booking.bookingStatus).toBe('cancelled');
    expect(booking.cancellation?.refundedAmount).toBeNull();
    expect(booking.cancellation?.cancelledBy).toBe(CUSTOMER_UID);

    const availSnap = await db.collection('availability').doc(AVAILABILITY_DOC_ID).get();
    const slots = availSnap.data()!.slots as Array<{
      start: string;
      end: string;
      available: boolean;
      bookingId: string | null;
    }>;
    const slot = slots.find((s) => s.start === SLOT_START && s.end === SLOT_END)!;
    expect(slot.available).toBe(true);
    expect(slot.bookingId).toBeNull();
  });

  it('customer cancelling someone else\'s booking is rejected with permission-denied', async () => {
    await seedUser(OTHER_CUSTOMER_UID, 'customer');
    await seedBooking({ userId: CUSTOMER_UID });

    await expect(
      handler({ bookingId: BOOKING_ID }, ctx(OTHER_CUSTOMER_UID)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('cancelling an already-cancelled booking is rejected with failed-precondition', async () => {
    await seedUser(CUSTOMER_UID, 'customer');
    await seedBooking({ bookingStatus: 'cancelled' });

    await expect(
      handler({ bookingId: BOOKING_ID }, ctx(CUSTOMER_UID)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('cancelling a completed booking is rejected with failed-precondition', async () => {
    await seedUser(CUSTOMER_UID, 'customer');
    await seedBooking({ bookingStatus: 'completed' });

    await expect(
      handler({ bookingId: BOOKING_ID }, ctx(CUSTOMER_UID)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('spa owner (different user from customer) can cancel; statusHistory actor === "spa"', async () => {
    await seedUser(CUSTOMER_UID, 'customer');
    await seedUser(SPA_OWNER_UID, 'spa_owner', SPA_ID);
    await seedBooking({ userId: CUSTOMER_UID });
    await seedAvailabilityHoldingSlot();

    const result = await handler(
      { bookingId: BOOKING_ID, reason: 'spa closing early' },
      ctx(SPA_OWNER_UID),
    );

    expect(result.success).toBe(true);

    const bookingSnap = await db.collection('bookings').doc(BOOKING_ID).get();
    const booking = bookingSnap.data()!;
    expect(booking.bookingStatus).toBe('cancelled');
    const history = booking.statusHistory as Array<{ actor: string; actorId: string }>;
    const cancelEntry = history.find((entry) => entry.actorId === SPA_OWNER_UID);
    expect(cancelEntry?.actor).toBe('spa');
  });
});
