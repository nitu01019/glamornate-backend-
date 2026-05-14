/**
 * Race / precondition regression test for `autoTransitionToEnRoute`.
 *
 * Phase 4 / Task 4.4 — promotes spec-logic-check-3's Round-2 ticket
 * (design doc line 924, 929) into Round 1.
 *
 * The race scenario:
 *   1. Cron snapshot read at T sees booking B with `bookingStatus='confirmed'`.
 *   2. Customer's `cancelBooking` commits at T+ε, flipping B to `'cancelled'`
 *      (cancelBooking.ts:85-113 inside its own runTransaction).
 *   3. Cron then issues a blind `doc.ref.update({bookingStatus:'en_route'})`
 *      with no precondition — overwrites the cancellation.
 *
 * Fix: wrap the per-doc update in `db.runTransaction` and re-fetch the doc
 * inside the transaction; only update if `bookingStatus === 'confirmed'`.
 *
 * This test asserts the precondition holds — i.e. when the in-txn re-read
 * shows `bookingStatus === 'cancelled'`, the cron does NOT issue an update
 * and does NOT enqueue a notification, and `transitioned` does NOT count
 * the document.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — shared mock state visible inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockUpdate,
  mockNotificationsAdd,
  mockRunTransaction,
  mockSnapshotDocs,
  mockTxnGet,
} = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockNotificationsAdd: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockSnapshotDocs: vi.fn(),
  mockTxnGet: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (must come before importing the function under test)
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = vi.fn().mockImplementation((name: string) => {
    if (name === 'bookings') {
      // Build the lookahead query chain. The cron does:
      //   .where('bookingStatus','==','confirmed')
      //   .where('scheduledAt','<=',lookahead)
      //   .where('scheduledAt','>=',fiveMinAgo)
      //   .limit(100)
      //   .get()
      const chain: Record<string, unknown> = {};
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.get = vi.fn().mockImplementation(() => Promise.resolve({ docs: mockSnapshotDocs() }));
      return chain;
    }
    if (name === 'notifications') {
      return { add: mockNotificationsAdd };
    }
    return {};
  });

  const firestoreInstance = {
    collection,
    runTransaction: mockRunTransaction,
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 1700000000, toDate: () => new Date(1700000000000) }),
    fromDate: (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), toDate: () => d }),
    fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000), toDate: () => new Date(ms) }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    arrayUnion: (...args: unknown[]) => ({ _arrayUnion: args }),
  };

  return { default: { firestore: firestoreFn }, firestore: firestoreFn };
});

vi.mock('firebase-functions', () => {
  const pubsub = {
    schedule: () => ({ onRun: (handler: Function) => handler }),
  };
  return {
    default: { pubsub, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    pubsub,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

// ---------------------------------------------------------------------------
// Import the function under test (after mocks)
// ---------------------------------------------------------------------------

import { autoTransitionToEnRoute } from '../scheduled/autoProcessBookings';

// ---------------------------------------------------------------------------
// Fixture: a booking-doc shape that the cron snapshot returns. The doc.ref
// has its own `update` (used by the un-fixed code) so we can assert it is
// NOT called once the precondition lands.
// ---------------------------------------------------------------------------

interface BookingDocData {
  userId: string;
  bookingStatus: 'confirmed' | 'cancelled' | 'en_route' | 'completed';
  checkIn?: unknown;
}

function makeBookingDoc(id: string, snapshotData: BookingDocData) {
  const ref = {
    id,
    update: mockUpdate,
  };
  return {
    id,
    ref,
    data: () => snapshotData,
  };
}

describe('autoTransitionToEnRoute — race precondition (Phase 4 / Task 4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshotDocs.mockReset();
    mockTxnGet.mockReset();
    mockRunTransaction.mockReset();
    mockUpdate.mockReset();
    mockNotificationsAdd.mockReset();
  });

  it('does NOT update or notify when the in-txn re-read shows the booking was cancelled mid-window', async () => {
    // Cron's pre-transaction snapshot still says `confirmed` (race window).
    const doc = makeBookingDoc('booking-race-1', {
      userId: 'user-1',
      bookingStatus: 'confirmed',
    });
    mockSnapshotDocs.mockReturnValue([doc]);

    // Inside the transaction, the re-read returns `cancelled` — simulating
    // the customer's cancelBooking having landed between snapshot-read and
    // transaction-start.
    mockTxnGet.mockResolvedValue({
      exists: true,
      data: () => ({ bookingStatus: 'cancelled', userId: 'user-1' }),
    });

    // Run the cron's per-doc transaction callback. The fix MUST call
    // db.runTransaction with a callback that:
    //   - reads doc.ref via t.get()
    //   - bails (no t.update) when bookingStatus !== 'confirmed'
    mockRunTransaction.mockImplementation(async (cb: Function) => {
      const t = {
        get: mockTxnGet,
        update: mockUpdate,
      };
      return cb(t);
    });

    const transitioned = await autoTransitionToEnRoute(new Date());

    // Precondition guarded: cron did not write anything for this doc.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNotificationsAdd).not.toHaveBeenCalled();
    // And the function reports zero successful transitions.
    expect(transitioned).toBe(0);
  });

  it('DOES update + notify when the in-txn re-read still shows confirmed', async () => {
    const doc = makeBookingDoc('booking-happy-1', {
      userId: 'user-2',
      bookingStatus: 'confirmed',
    });
    mockSnapshotDocs.mockReturnValue([doc]);

    // In-txn read confirms status is still `confirmed` — happy path.
    mockTxnGet.mockResolvedValue({
      exists: true,
      data: () => ({ bookingStatus: 'confirmed', userId: 'user-2' }),
    });

    mockRunTransaction.mockImplementation(async (cb: Function) => {
      const t = {
        get: mockTxnGet,
        update: mockUpdate,
      };
      return cb(t);
    });

    const transitioned = await autoTransitionToEnRoute(new Date());

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockNotificationsAdd).toHaveBeenCalledTimes(1);
    expect(transitioned).toBe(1);

    // Confirm the update payload still flips status to en_route.
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.bookingStatus).toBe('en_route');
  });

  it('skips bookings already checked in even when status is confirmed (existing invariant preserved)', async () => {
    const doc = makeBookingDoc('booking-checked-in', {
      userId: 'user-3',
      bookingStatus: 'confirmed',
      checkIn: { at: 'SERVER_TIMESTAMP' },
    });
    mockSnapshotDocs.mockReturnValue([doc]);

    // The check-in guard happens BEFORE the transaction, so runTransaction
    // must NOT be invoked at all for this doc.
    mockRunTransaction.mockImplementation(async (cb: Function) => {
      const t = { get: mockTxnGet, update: mockUpdate };
      return cb(t);
    });

    const transitioned = await autoTransitionToEnRoute(new Date());

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNotificationsAdd).not.toHaveBeenCalled();
    expect(transitioned).toBe(0);
  });
});
