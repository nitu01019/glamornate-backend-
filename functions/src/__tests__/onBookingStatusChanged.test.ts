/**
 * Idempotency tests for the onBookingStatusChanged Firestore trigger.
 *
 * Cloud Functions delivers Firestore triggers at-least-once. The handler
 * guards against duplicate side-effects by writing a sentinel doc to
 * `_processedEvents/{eventId}` inside a transaction; if the sentinel
 * already exists the handler short-circuits.
 *
 * Spec ref: design doc Section 1 (SC-8), Section 6 — Phase 4.5.
 *
 * These tests are pure mock-based (no emulator needed) and lock the
 * idempotency contract:
 *   1. First delivery of an eventId → sentinel doesn't exist → transaction
 *      writes sentinel WITH expiresAt (TTL 7d) → side-effects fire.
 *   2. Duplicate delivery of the same eventId → sentinel exists → handler
 *      returns null WITHOUT firing any side-effects (notifications,
 *      realtime updates, batch writes, analytics).
 *
 * Mock pattern mirrors createBooking.test.ts (vi.hoisted, firebase-admin
 * + firebase-functions mocks, identity-shim for the trigger registration).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() — these refs are visible inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockTransactionGet,
  mockTransactionSet,
  mockRunTransaction,
  mockBatch,
  mockBatchSet,
  mockBatchCommit,
  mockCollection,
  mockDoc,
  mockWhere,
  mockGet,
  mockAdd,
  mockTriggerBookingUpdate,
  mockEnqueueNotification,
} = vi.hoisted(() => ({
  mockTransactionGet: vi.fn(),
  mockTransactionSet: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockBatch: vi.fn(),
  mockBatchSet: vi.fn(),
  mockBatchCommit: vi.fn(),
  mockCollection: vi.fn(),
  mockDoc: vi.fn(),
  mockWhere: vi.fn(),
  mockGet: vi.fn(),
  mockAdd: vi.fn(),
  mockTriggerBookingUpdate: vi.fn(),
  mockEnqueueNotification: vi.fn(),
}));

// ---------------------------------------------------------------------------
// firebase-admin mock
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const firestoreInstance = {
    collection: mockCollection,
    runTransaction: mockRunTransaction,
    batch: mockBatch,
  };

  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    fromDate: (d: Date) => ({
      seconds: Math.floor(d.getTime() / 1000),
      nanoseconds: 0,
      toDate: () => d,
    }),
    now: () => ({
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
      toDate: () => new Date(),
    }),
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

// ---------------------------------------------------------------------------
// firebase-functions mock — `functions.firestore.document(...).onUpdate(fn)`
// returns `fn` directly so the test can invoke the handler.
// ---------------------------------------------------------------------------

vi.mock('firebase-functions', () => {
  const firestore = {
    document: () => ({
      onUpdate: (handler: Function) => handler,
    }),
  };
  return {
    default: { firestore, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    firestore,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Side-effect dependencies — mocked so we can assert fire/no-fire
// ---------------------------------------------------------------------------

vi.mock('../utils/notifications-outbox', () => ({
  enqueueNotificationFromContext: mockEnqueueNotification,
}));

vi.mock('../utils/realtime-tracking', () => ({
  triggerBookingUpdate: mockTriggerBookingUpdate,
}));

vi.mock('../utils/validator', () => ({
  sanitizeInput: (s: string) => s,
}));

vi.mock('../utils/maps-url', () => ({
  buildMapsUrl: () => 'https://maps.example/test',
}));

// ---------------------------------------------------------------------------
// Import the handler under test (after all mocks are wired)
// ---------------------------------------------------------------------------

import { onBookingStatusChanged } from '../events/onBookingStatusChanged';

const handler = onBookingStatusChanged as unknown as (
  change: {
    before: { data: () => unknown };
    after: { data: () => unknown; id?: string };
  },
  context: { params: { bookingId: string }; eventId: string }
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bookingChange(beforeStatus: string, afterStatus: string) {
  const after = {
    bookingStatus: afterStatus,
    userId: 'user-1',
    spaId: 'spa-1',
    slot: { date: '2027-06-15', start: '10:00' },
    customer: { name: 'Asha', email: 'a@example.com', phone: '+919999999999' },
    services: [{ name: 'Massage' }],
    pricing: { total: 1500 },
    bookingLocation: 'spa',
  };
  return {
    before: { data: () => ({ bookingStatus: beforeStatus, userId: 'user-1', spaId: 'spa-1' }) },
    after: { data: () => after, id: 'booking-1' },
  };
}

function context(eventId: string) {
  return { params: { bookingId: 'booking-1' }, eventId };
}

/**
 * Configure default mocks for the en_route transition (lightest side-effect
 * path: just `triggerBookingUpdate` + one `enqueueNotificationFromContext`,
 * no batch, no spa-staff query, no analytics). Keeps the test focused on
 * the idempotency guard rather than the downstream notification logic.
 */
function configureMocksForEnRoute(opts: { sentinelExists: boolean }) {
  // _processedEvents/{eventId} doc handle
  const sentinelDocRef = { id: 'evt-1' };
  mockCollection.mockImplementation((name: string) => ({
    doc: () => sentinelDocRef,
    where: mockWhere,
  }));

  // transaction.get(sentinelRef) returns either existing or missing
  mockTransactionGet.mockResolvedValue({
    exists: opts.sentinelExists,
  });

  mockRunTransaction.mockImplementation(async (cb: Function) => {
    const txn = {
      get: mockTransactionGet,
      set: mockTransactionSet,
    };
    return cb(txn);
  });

  mockTriggerBookingUpdate.mockResolvedValue(undefined);
  mockEnqueueNotification.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onBookingStatusChanged — _processedEvents idempotency (Phase 4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first delivery: writes sentinel inside transaction with expiresAt (TTL 7d) and fires side-effects', async () => {
    configureMocksForEnRoute({ sentinelExists: false });

    await handler(
      bookingChange('confirmed', 'en_route'),
      context('event-abc-123')
    );

    // Transaction was opened
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);

    // Sentinel write happened INSIDE the transaction (transaction.set, not batch.set)
    expect(mockTransactionSet).toHaveBeenCalledTimes(1);
    const [, sentinelPayload] = mockTransactionSet.mock.calls[0];

    // Sentinel payload contract
    expect(sentinelPayload.eventId).toBe('event-abc-123');
    expect(sentinelPayload.bookingId).toBe('booking-1');
    expect(sentinelPayload.fromStatus).toBe('confirmed');
    expect(sentinelPayload.toStatus).toBe('en_route');
    expect(sentinelPayload.processedAt).toBe('SERVER_TIMESTAMP');

    // TTL: expiresAt is a Firestore Timestamp ~7 days in the future.
    // Allow a 60s tolerance window for clock drift between the test
    // setup and the handler-internal Date.now() call.
    expect(sentinelPayload.expiresAt).toBeDefined();
    const expiresAtMs = sentinelPayload.expiresAt.toDate().getTime();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAtMs - expectedMs)).toBeLessThan(60_000);

    // Side-effects fired exactly once (en_route enqueues a single
    // notification + one realtime tracking event).
    expect(mockTriggerBookingUpdate).toHaveBeenCalledTimes(1);
    expect(mockTriggerBookingUpdate).toHaveBeenCalledWith(
      'booking-1',
      'status',
      'confirmed',
      'en_route'
    );
    expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('duplicate delivery: sentinel exists → handler short-circuits without firing side-effects', async () => {
    configureMocksForEnRoute({ sentinelExists: true });

    const result = await handler(
      bookingChange('confirmed', 'en_route'),
      context('event-abc-123')
    );

    // Transaction WAS opened (the read is required to check the sentinel),
    // but no sentinel write happened (we short-circuited inside the txn).
    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionSet).not.toHaveBeenCalled();

    // Side-effects MUST NOT fire on a duplicate delivery.
    expect(mockTriggerBookingUpdate).not.toHaveBeenCalled();
    expect(mockEnqueueNotification).not.toHaveBeenCalled();

    // Handler returned null (the explicit early-exit value).
    expect(result).toBeNull();
  });

  it('no-op: when bookingStatus did not change, transaction is never opened', async () => {
    // Belt-and-braces: confirms the early-return BEFORE the idempotency
    // guard fires (so we don't waste a transaction on noise updates like
    // statusHistory writes that don't flip the top-level status).
    configureMocksForEnRoute({ sentinelExists: false });

    await handler(
      bookingChange('en_route', 'en_route'),
      context('event-noop-1')
    );

    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockTransactionSet).not.toHaveBeenCalled();
    expect(mockTriggerBookingUpdate).not.toHaveBeenCalled();
    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });
});
