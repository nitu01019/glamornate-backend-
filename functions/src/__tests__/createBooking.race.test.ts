/**
 * Race / TOCTOU regression tests for `createBooking`.
 *
 * Phase 3 A3.1 moved the user-overlap re-check INSIDE the `runTransaction`
 * callback (and added `.limit(20)` to bound the scan) so a concurrent draft
 * cannot slip in between the overlap read and the booking write.
 *
 * These tests are regression guards, not a full Firestore simulator:
 *   1. `concurrent overlapping calls` — two simultaneous calls with the same
 *      time window: exactly one succeeds with `already-exists` raised on the
 *      other (the overlap query inside the txn now sees the first call's
 *      already-written booking).
 *   2. `.limit(20) is applied` — asserts the overlap query passed to
 *      `txn.get(...)` was built with `.limit(20)` (cheap structural check
 *      against accidental regression).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted — shared mock state visible inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockSet,
  mockUpdate,
  mockGetAll,
  mockRunTransaction,
  mockDocFn,
  mockWhere,
  mockLimit,
  GENERATED_BOOKING_ID,
} = vi.hoisted(() => ({
  mockSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetAll: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockDocFn: vi.fn(),
  mockWhere: vi.fn(),
  mockLimit: vi.fn(),
  GENERATED_BOOKING_ID: 'booking-race-1',
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = vi.fn().mockImplementation(() => ({
    doc: mockDocFn,
    where: mockWhere,
  }))
  const firestoreInstance = {
    collection,
    getAll: mockGetAll,
    runTransaction: mockRunTransaction,
  }
  const firestoreFn = () => firestoreInstance
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 1700000000, toDate: () => new Date(1700000000000) }),
    fromDate: (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), toDate: () => d }),
  }
  firestoreFn.FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    increment: (n: number) => ({ _increment: n }),
    arrayUnion: (...args: unknown[]) => ({ _arrayUnion: args }),
  }
  return { default: { firestore: firestoreFn }, firestore: firestoreFn }
})

vi.mock('firebase-functions', () => {
  class HttpsError extends Error {
    code: string
    details: unknown
    constructor(code: string, message: string, details?: unknown) {
      super(message)
      this.name = 'HttpsError'
      this.code = code
      this.details = details
    }
  }
  const https = { HttpsError, onCall: (handler: Function) => handler }
  const runWith = () => ({ https, region: () => ({ https }) })
  return {
    default: { runWith, https },
    runWith,
    https,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../utils/error-handler', () => ({
  handleError: (err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err) return err
    return new Error('internal')
  },
}))

// Pass-through shim for the Phase 2 withRateLimit wrapper. The real helper
// hits Firestore on every invocation; in tests it would require setting up
// `_rateLimits` mocks. Short-circuit it.
vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (_opts: unknown, fn: Function) => fn,
}))

// ---------------------------------------------------------------------------
// Import the function under test (after mocks)
// ---------------------------------------------------------------------------

import { createBooking } from '../callable/createBooking'

const handler = createBooking as unknown as (
  data: unknown,
  context: { auth?: { uid: string } },
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(start = '10:00', end = '11:00') {
  return {
    spaId: 'spa-race',
    therapistId: 'therapist-race',
    serviceIds: ['svc-1'],
    addonIds: [],
    slot: { date: '2027-06-15', start, end, duration: 60 },
  }
}

const authedContext = (uid = 'user-race') => ({ auth: { uid } })

// In-memory "store" the mocks share, so the second concurrent call sees the
// first call's write. Only the bookings collection matters for race detection.
type StoredBooking = {
  id: string
  userId: string
  bookingStatus: string
  isActive: boolean
  slot: { date: string; start: string; end: string }
}

function setupRaceFixtures() {
  const bookings: StoredBooking[] = []

  // Build the overlap-query chain. Tag with `__overlapQuery` and `__limit` so
  // the txn.get mock can recognise it AND the limit-assertion test can read
  // back the value passed to .limit().
  const overlapChain: Record<string, unknown> = {
    __overlapQuery: true,
    __limit: undefined as number | undefined,
  }
  mockLimit.mockImplementation((n: number) => {
    overlapChain.__limit = n
    return overlapChain
  })
  overlapChain.limit = mockLimit
  overlapChain.get = () => Promise.resolve({ docs: [] })

  mockWhere.mockReturnValue({
    where: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(overlapChain),
    }),
  })

  // No availability doc → the no-availability code path runs (still wrapped
  // in a txn after A3.1). This keeps the race test focused on the overlap
  // contract, not on slot-locking semantics.
  const userProfileDoc = {
    exists: true,
    data: () => ({ profile: { displayName: 'Race User', email: 'r@example.com' } }),
  }
  mockDocFn.mockImplementation((docId?: string) => {
    if (!docId) {
      // Generate a unique id per call so two concurrent calls get distinct refs.
      const id = `${GENERATED_BOOKING_ID}-${bookings.length + 1}`
      return { id, set: mockSet }
    }
    if (docId.startsWith('spa-race_')) {
      return { get: () => Promise.resolve({ exists: false, data: () => null }) }
    }
    if (docId === 'user-race') {
      return { get: () => Promise.resolve(userProfileDoc) }
    }
    if (docId === 'spa-race') {
      // Wave 9C (Booking Flow Fix v3.1, 2026-05-02) — global-fallback
      // pricing path now requires the spa to advertise the service via
      // the `services` array. Stub it so the verification short-circuits
      // through branch (a) and never touches the subcollection probe.
      return {
        get: () =>
          Promise.resolve({
            exists: true,
            data: () => ({ services: ['svc-1'] }),
          }),
      }
    }
    return { get: () => Promise.resolve({ exists: false, data: () => null }) }
  })

  // Pricing lookups: spa override → fallback to global basePrice.
  mockGetAll.mockImplementation((..._refs: unknown[]) =>
    Promise.resolve([{ exists: true, data: () => ({ basePrice: 1000, name: 'Massage' }) }]),
  )

  // The transaction mock SERIALIZES concurrent invocations — Firestore txns
  // are isolated, so two overlapping calls must execute their callbacks
  // sequentially. Without this serialization, JS's microtask interleaving
  // would let both txns read an empty `bookings` array before either writes.
  let txnQueue: Promise<unknown> = Promise.resolve()
  mockRunTransaction.mockImplementation(async (cb: Function) => {
    const run = async () => {
      const transaction = {
        get: vi.fn().mockImplementation((arg: unknown) => {
          if ((arg as { __overlapQuery?: boolean })?.__overlapQuery) {
            return Promise.resolve({
              docs: bookings.map((b) => ({ data: () => b })),
            })
          }
          return Promise.resolve({ exists: false, data: () => null })
        }),
        update: mockUpdate,
        set: vi.fn().mockImplementation((ref: { id: string }, data: StoredBooking) => {
          bookings.push({ ...data, id: ref.id })
          mockSet(ref, data)
        }),
      }
      return cb(transaction)
    }
    // Chain off the queue: each call awaits the previous one. We swallow
    // upstream errors so a failing txn does not poison the chain for
    // subsequent calls.
    const myTurn = txnQueue.then(run, run)
    txnQueue = myTurn.catch(() => undefined)
    return myTurn
  })

  return { bookings, overlapChain }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBooking (race / TOCTOU regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TAX_RATE_PERCENT = '18'
    process.env.PLATFORM_FEE_PERCENT = '20'
  })

  it('rejects a second concurrent draft with the same time window (overlap re-check inside txn)', async () => {
    setupRaceFixtures()

    // Fire two overlapping calls "concurrently" (they share the in-memory
    // store; whichever resolves first leaves a booking the other will see).
    const results = await Promise.allSettled([
      handler(validInput('10:00', '11:00'), authedContext()),
      handler(validInput('10:30', '11:30'), authedContext()), // overlaps the first
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // Exactly one wins; the other is rejected by the in-txn overlap check.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const reject = rejected[0] as PromiseRejectedResult
    const err = reject.reason as { code?: string; message?: string }
    expect(err.code).toBe('already-exists')
    expect(err.message).toContain('booking')
  })

  it('builds the overlap query with .limit(20) so the in-txn scan is bounded', async () => {
    const { overlapChain } = setupRaceFixtures()

    await handler(validInput('14:00', '15:00'), authedContext())

    // The function under test must have called `.limit(20)` on the overlap
    // query chain. We assert this two ways: (a) the spy was called with 20,
    // (b) the resulting chain remembers the value.
    expect(mockLimit).toHaveBeenCalledWith(20)
    expect(overlapChain.__limit).toBe(20)
  })
})
