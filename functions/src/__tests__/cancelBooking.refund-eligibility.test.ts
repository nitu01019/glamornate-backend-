/**
 * cancelBooking — refund-eligibility regression lock (Logic 4.2, Phase 4).
 *
 * Pay-at-spa is the only payment mode (Stripe removed 2026-05-02), so:
 *   1. `cancellation.refundedAmount` MUST be `null` at cancel time.
 *   2. The returned `refundAmount` MUST be `null` (client backward-compat).
 *   3. There is NO server-side cancellation time-window — a customer may
 *      cancel at any non-terminal point, including bookings whose slot.date
 *      is in the past (e.g. a confirmed booking the customer never showed
 *      to). Cancellation policy / no-show fees are spa-side, out-of-band.
 *
 * Existing emulator suite at `cancelBooking.emulator.test.ts` covers (1) +
 * (2) under a real Firestore. This file locks (3) explicitly with the
 * mock-based pattern from `createBooking.test.ts` — no emulator dep, runs
 * on every CI invocation.
 *
 * Rationale: the absence of a time-window gate is an architectural
 * commitment, not an oversight. Without an explicit regression test, a
 * future "add cancellation deadline" change could quietly break customer
 * cancellation of past-dated stale rows (e.g. left-over confirmed bookings
 * after a no-show), and only surface in production. This test pins
 * `cancelBooking.ts:57-58` (status-only precondition) by exercising both
 * past and far-future dates.
 *
 * References:
 *   - `cancelBooking.ts:57-59` — only status-precondition, no date check
 *   - `cancelBooking.ts:94-113` — writes `cancellation.refundedAmount: null`
 *   - `cancelBooking.ts:151-157` — returns `refundAmount: null`
 *   - Spec doc Section 6 (out-of-scope) — refund/no-show is Round-2 / spa-side
 *   - Spec doc Section 2b.4 line 140 — pay-at-spa: refund fields null at create
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() — variables available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockBookingDocGet,
  mockUserDocGet,
  mockAvailabilityDocGet,
  mockTxnUpdate,
  mockRunTransaction,
  mockDocFn,
  mockCollectionFn,
} = vi.hoisted(() => ({
  mockBookingDocGet: vi.fn(),
  mockUserDocGet: vi.fn(),
  mockAvailabilityDocGet: vi.fn(),
  mockTxnUpdate: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockDocFn: vi.fn(),
  mockCollectionFn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks (must precede import of the callable under test)
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const firestoreInstance = {
    collection: mockCollectionFn,
    runTransaction: mockRunTransaction,
  };
  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 1700000000, toDate: () => new Date(1700000000000) }),
    fromDate: (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), toDate: () => d }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    arrayUnion: (...args: unknown[]) => ({ _arrayUnion: args }),
  };
  return {
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
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
    onCall: (handler: Function) => handler,
  };
  const runWith = () => ({ https, region: () => ({ https }) });
  return {
    default: { runWith, https },
    runWith,
    https,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../utils/error-handler', () => ({
  handleError: (err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err) return err;
    return new Error('internal');
  },
}));

vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (_opts: unknown, fn: Function) => fn,
}));

vi.mock('../utils/audit-log', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import the callable AFTER mocks
// ---------------------------------------------------------------------------

import { cancelBooking } from '../callable/cancelBooking';

const handler = cancelBooking as unknown as (
  data: unknown,
  context: { auth?: { uid: string } },
) => Promise<{ success: boolean; refundAmount: number | null; currency: string }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOMER_UID = 'customer-1';
const BOOKING_ID = 'booking-1';
const SPA_ID = 'spa-1';
const THERAPIST_ID = 'therapist-1';

interface SeedOpts {
  slotDate: string;
  bookingStatus?: string;
  userId?: string;
}

function setupMocks(opts: SeedOpts) {
  const bookingDoc = {
    exists: true,
    ref: { id: BOOKING_ID, path: `bookings/${BOOKING_ID}` },
    data: () => ({
      userId: opts.userId ?? CUSTOMER_UID,
      spaId: SPA_ID,
      therapistId: THERAPIST_ID,
      bookingStatus: opts.bookingStatus ?? 'confirmed',
      slot: { date: opts.slotDate, start: '10:00', end: '11:00' },
      pricing: { currency: 'INR' },
    }),
  };
  mockBookingDocGet.mockResolvedValue(bookingDoc);

  const userDoc = {
    exists: true,
    data: () => ({ role: 'customer' }),
  };
  mockUserDocGet.mockResolvedValue(userDoc);

  // No availability doc (the cancel flow tolerates missing availability —
  // it just skips the slot release. We still want to confirm the booking
  // status flips and refundedAmount stays null.)
  mockAvailabilityDocGet.mockResolvedValue({ exists: false, data: () => null });

  mockCollectionFn.mockImplementation((name: string) => ({
    doc: (id: string) => {
      if (name === 'bookings') {
        return { ...bookingDoc.ref, get: mockBookingDocGet };
      }
      if (name === 'users') {
        return { id, get: mockUserDocGet };
      }
      if (name === 'availability') {
        return {
          id,
          ref: { id, path: `availability/${id}` },
          get: mockAvailabilityDocGet,
        };
      }
      return { id, get: vi.fn().mockResolvedValue({ exists: false }) };
    },
  }));

  mockRunTransaction.mockImplementation(async (cb: Function) => {
    const txn = {
      get: vi.fn().mockResolvedValue({ exists: false, data: () => null }),
      update: mockTxnUpdate,
    };
    return cb(txn);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancelBooking — refund eligibility (pay-at-spa nuance, Logic 4.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refundedAmount in cancellation block is null (pay-at-spa)', async () => {
    setupMocks({ slotDate: '2027-06-15' });

    const result = await handler(
      { bookingId: BOOKING_ID, reason: 'changed plans' },
      { auth: { uid: CUSTOMER_UID } },
    );

    expect(result.success).toBe(true);
    expect(result.refundAmount).toBeNull();
    expect(result.currency).toBe('INR');

    const bookingUpdateCall = mockTxnUpdate.mock.calls.find(
      (call) => call[1]?.bookingStatus === 'cancelled',
    );
    expect(bookingUpdateCall).toBeDefined();
    expect(bookingUpdateCall[1].cancellation.refundedAmount).toBeNull();
    expect(bookingUpdateCall[1].cancellation.reason).toBe('changed plans');
    expect(bookingUpdateCall[1].cancellation.cancelledBy).toBe(CUSTOMER_UID);
  });

  it('cancels a far-past confirmed booking (no time-window restriction)', async () => {
    // Slot 5 years in the past — proves cancelBooking has no
    // server-side cancellation deadline. Customer can cancel any
    // non-terminal booking regardless of when slot.date occurred.
    setupMocks({ slotDate: '2021-01-15' });

    const result = await handler(
      { bookingId: BOOKING_ID, reason: 'cleanup stale row' },
      { auth: { uid: CUSTOMER_UID } },
    );

    expect(result.success).toBe(true);
    expect(result.refundAmount).toBeNull();
  });

  it('cancels a far-future confirmed booking (no upper time-window either)', async () => {
    setupMocks({ slotDate: '2030-12-31' });

    const result = await handler(
      { bookingId: BOOKING_ID },
      { auth: { uid: CUSTOMER_UID } },
    );

    expect(result.success).toBe(true);
    expect(result.refundAmount).toBeNull();
  });

  it('default cancellation reason is recorded when caller omits it', async () => {
    setupMocks({ slotDate: '2027-06-15' });

    await handler({ bookingId: BOOKING_ID }, { auth: { uid: CUSTOMER_UID } });

    const bookingUpdateCall = mockTxnUpdate.mock.calls.find(
      (call) => call[1]?.bookingStatus === 'cancelled',
    );
    expect(bookingUpdateCall[1].cancellation.reason).toBe('Cancelled by user');
  });

  it('returned currency falls back to INR when pricing.currency missing', async () => {
    // Mirrors `cancelBooking.ts:156` — `booking.pricing?.currency ?? 'INR'`.
    const bookingDoc = {
      exists: true,
      ref: { id: BOOKING_ID, path: `bookings/${BOOKING_ID}` },
      data: () => ({
        userId: CUSTOMER_UID,
        spaId: SPA_ID,
        therapistId: THERAPIST_ID,
        bookingStatus: 'confirmed',
        slot: { date: '2027-06-15', start: '10:00', end: '11:00' },
        // pricing intentionally absent
      }),
    };
    mockBookingDocGet.mockResolvedValue(bookingDoc);
    mockUserDocGet.mockResolvedValue({ exists: true, data: () => ({ role: 'customer' }) });
    mockAvailabilityDocGet.mockResolvedValue({ exists: false, data: () => null });
    mockCollectionFn.mockImplementation((name: string) => ({
      doc: (id: string) => {
        if (name === 'bookings') return { ...bookingDoc.ref, get: mockBookingDocGet };
        if (name === 'users') return { id, get: mockUserDocGet };
        return { id, ref: { id }, get: mockAvailabilityDocGet };
      },
    }));
    mockRunTransaction.mockImplementation(async (cb: Function) => {
      const txn = {
        get: vi.fn().mockResolvedValue({ exists: false, data: () => null }),
        update: mockTxnUpdate,
      };
      return cb(txn);
    });

    const result = await handler(
      { bookingId: BOOKING_ID },
      { auth: { uid: CUSTOMER_UID } },
    );

    expect(result.refundAmount).toBeNull();
    expect(result.currency).toBe('INR');
  });
});
