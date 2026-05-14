/**
 * scheduledAt + autoTransitionToEnRoute — emulator integration test.
 *
 * Locks the second half of SC-9 (V-3): once `createBooking` writes the
 * `scheduledAt` field (Task 2.1), the scheduled job
 * `autoTransitionToEnRoute` must successfully pick the booking up and flip
 * `bookingStatus` from `'confirmed'` to `'en_route'` once the appointment
 * window is reached.
 *
 * Strategy:
 *   - Seed a booking shaped exactly like the post-Task-2.1 createBooking
 *     write payload (canonical contract from `createBooking.ts:357-415`),
 *     with `scheduledAt` deliberately set to `now - 1 minute` so it falls
 *     inside the autoTransition lookahead window
 *     (`fiveMinAgo <= scheduledAt <= now + 5min`,
 *     see `autoProcessBookings.ts:95-101`).
 *   - Call `autoTransitionToEnRoute(now)` directly.
 *   - Assert the booking is now `'en_route'` and a status-history entry
 *     was appended.
 *
 * Mocking strategy mirrors `cancelBooking.emulator.test.ts`:
 *   - `firebase-functions.https.onCall` -> identity (so any callable is
 *     directly invokable);
 *   - `firebase-admin` is left real so reads/writes hit the live
 *     Firestore emulator.
 *
 * If the Firestore emulator isn't running (exit 7 / connection refused on
 * `localhost:8080`), the suite short-circuits via `describeIfEmulator` so
 * `npm test` still passes in CI environments without the emulator.
 *
 * Runbook for running locally with the emulator:
 *   firebase emulators:start --only firestore
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npm test -- scheduledAt-autotransition
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Emulator reachability probe (mirrors cancelBooking.emulator.test.ts:30-43)
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
// Mocks (must come before importing the function under test)
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

// ---------------------------------------------------------------------------
// Real firebase-admin connected to the emulator
// ---------------------------------------------------------------------------

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

type AutoTransition = (now: Date) => Promise<number>;

let autoTransitionToEnRoute: AutoTransition;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER_UID = 'auto-transition-customer-1';
const SPA_ID = 'auto-transition-spa-1';
const THERAPIST_ID = 'auto-transition-therapist-1';
const BOOKING_ID = 'auto-transition-booking-1';
const SLOT_DATE = '2026-06-15';
const SLOT_START = '10:00';
const SLOT_END = '11:00';

async function clearCollection(name: string): Promise<void> {
  const snap = await db.collection(name).get();
  if (snap.empty) return;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

interface SeedConfirmedBookingOpts {
  scheduledAt: admin.firestore.Timestamp;
  bookingStatus?: string;
}

async function seedConfirmedBooking(opts: SeedConfirmedBookingOpts): Promise<void> {
  const { scheduledAt, bookingStatus = 'confirmed' } = opts;
  const now = admin.firestore.Timestamp.now();
  await db
    .collection('bookings')
    .doc(BOOKING_ID)
    .set({
      userId: CUSTOMER_UID,
      spaId: SPA_ID,
      therapistId: THERAPIST_ID,
      bookingStatus,
      slot: { date: SLOT_DATE, start: SLOT_START, end: SLOT_END, duration: 60 },
      scheduledAt,
      pricing: { services: 1000, addons: 0, tax: 0, discount: 0, platformFee: 0, total: 1000, currency: 'INR' },
      paymentMode: 'pay_at_spa',
      isActive: true,
      createdBy: 'customer',
      statusHistory: [
        {
          status: 'confirmed',
          from: null,
          to: 'confirmed',
          actor: 'customer',
          actorId: CUSTOMER_UID,
          timestamp: now,
          reason: 'Booking created (pay-at-spa)',
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfEmulator('autoTransitionToEnRoute integration (SC-9, V-3)', () => {
  beforeAll(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    }
    const mod = await import('../scheduled/autoProcessBookings');
    autoTransitionToEnRoute = mod.autoTransitionToEnRoute;
  });

  beforeEach(async () => {
    await Promise.all([
      clearCollection('bookings'),
      clearCollection('notifications'),
    ]);
  });

  it('transitions a confirmed booking to en_route once scheduledAt window is reached', async () => {
    // scheduledAt = (now - 1 minute) — inside the 5-minute lookahead window
    // [now - 5min, now + 5min] checked at autoProcessBookings.ts:95-101.
    const now = new Date();
    const scheduledAt = admin.firestore.Timestamp.fromMillis(now.getTime() - 60_000);

    await seedConfirmedBooking({ scheduledAt });

    const transitioned = await autoTransitionToEnRoute(now);

    expect(transitioned).toBe(1);

    const bookingSnap = await db.collection('bookings').doc(BOOKING_ID).get();
    const booking = bookingSnap.data()!;
    expect(booking.bookingStatus).toBe('en_route');

    // statusHistory should have appended an en_route entry via arrayUnion.
    const history = booking.statusHistory as Array<{ status: string; actor: string }>;
    expect(history.some((h) => h.status === 'en_route' && h.actor === 'system')).toBe(true);
  });

  it('does NOT transition a booking whose scheduledAt is in the future beyond the lookahead', async () => {
    // scheduledAt = (now + 1 hour) — well outside the +5 minute lookahead.
    const now = new Date();
    const scheduledAt = admin.firestore.Timestamp.fromMillis(now.getTime() + 60 * 60 * 1000);

    await seedConfirmedBooking({ scheduledAt });

    const transitioned = await autoTransitionToEnRoute(now);

    expect(transitioned).toBe(0);

    const bookingSnap = await db.collection('bookings').doc(BOOKING_ID).get();
    expect(bookingSnap.data()!.bookingStatus).toBe('confirmed');
  });
});
