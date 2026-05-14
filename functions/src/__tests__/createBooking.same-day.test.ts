/**
 * SC-1 regression lock — multi-booking same-day overlap semantics.
 *
 * The existing `createBooking.race.test.ts` covers the TOCTOU race for two
 * concurrent overlapping windows. It does NOT lock down the broader SC-1
 * contract: a user must be free to book two non-overlapping slots on the
 * same date, and any overlap (partial OR identical-start) must surface as
 * `DUPLICATE_BOOKING`.
 *
 * This file is the SC-1 regression lock. Tests are sequential (the second
 * call sees the first call's write through the shared in-memory store),
 * so they exercise the steady-state "second draft, prior booking already
 * persisted" path rather than the simultaneous-fire path.
 *
 *   1. same date, non-overlapping slots (10:00–11:00 + 14:00–15:00) →
 *      both succeed with distinct booking ids.
 *   2. same date, overlapping slots (10:00–11:00 + 10:30–11:30) →
 *      first succeeds, second throws `already-exists` /
 *      `DUPLICATE_BOOKING`.
 *   3. same date, identical start/end (10:00–11:00 twice) →
 *      first succeeds, second throws `already-exists` /
 *      `DUPLICATE_BOOKING`.
 *
 * Mocked Firestore — no emulator dependency.
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
} = vi.hoisted(() => ({
  mockSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetAll: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockDocFn: vi.fn(),
  mockWhere: vi.fn(),
  mockLimit: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Module mocks (mirror createBooking.race.test.ts so the two suites share
// behaviour and can be reasoned about side-by-side)
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
) => Promise<{ bookingId: string } | unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAME_DAY = '2027-06-15'

function validInput(start: string, end: string, date: string = SAME_DAY) {
  return {
    spaId: 'spa-sameday',
    therapistId: 'therapist-sameday',
    serviceIds: ['svc-1'],
    addonIds: [],
    slot: { date, start, end, duration: 60 },
  }
}

const authedContext = (uid = 'user-sameday') => ({ auth: { uid } })

type StoredBooking = {
  id: string
  userId: string
  bookingStatus: string
  isActive: boolean
  slot: { date: string; start: string; end: string }
}

function setupSameDayFixtures() {
  const bookings: StoredBooking[] = []
  let nextDocCounter = 0

  const overlapChain: Record<string, unknown> = { __overlapQuery: true }
  mockLimit.mockImplementation(() => overlapChain)
  overlapChain.limit = mockLimit
  overlapChain.get = () => Promise.resolve({ docs: [] })

  mockWhere.mockReturnValue({
    where: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(overlapChain),
    }),
  })

  const userProfileDoc = {
    exists: true,
    data: () => ({ profile: { displayName: 'Same-Day User', email: 'sd@example.com' } }),
  }
  mockDocFn.mockImplementation((docId?: string) => {
    if (!docId) {
      // Generate a unique booking id per call so the two sequential calls
      // get distinct refs (mirrors Firestore `collection().doc()` auto-id).
      nextDocCounter += 1
      const id = `booking-sameday-${nextDocCounter}`
      return { id, set: mockSet }
    }
    if (docId.startsWith('spa-sameday_')) {
      return { get: () => Promise.resolve({ exists: false, data: () => null }) }
    }
    if (docId === 'user-sameday') {
      return { get: () => Promise.resolve(userProfileDoc) }
    }
    if (docId === 'spa-sameday') {
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

  mockGetAll.mockImplementation((..._refs: unknown[]) =>
    Promise.resolve([{ exists: true, data: () => ({ basePrice: 1000, name: 'Massage' }) }]),
  )

  // Sequential serialisation — same as the race test, so two back-to-back
  // calls in this suite always see the previous call's write committed
  // before they run their overlap check.
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
    const myTurn = txnQueue.then(run, run)
    txnQueue = myTurn.catch(() => undefined)
    return myTurn
  })

  return { bookings, overlapChain }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBooking — SC-1 multi-booking same-day regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TAX_RATE_PERCENT = '18'
    process.env.PLATFORM_FEE_PERCENT = '20'
  })

  it('accepts two non-overlapping slots on the same date with distinct booking ids', async () => {
    const { bookings } = setupSameDayFixtures()

    const first = (await handler(validInput('10:00', '11:00'), authedContext())) as {
      bookingId: string
    }
    const second = (await handler(validInput('14:00', '15:00'), authedContext())) as {
      bookingId: string
    }

    expect(first.bookingId).toBeDefined()
    expect(second.bookingId).toBeDefined()
    expect(first.bookingId).not.toBe(second.bookingId)
    expect(bookings).toHaveLength(2)
    // Both rows are persisted with the same date — the SC-1 contract is that
    // same-date is permitted as long as the [start, end) windows do not
    // intersect.
    expect(bookings.every((b) => b.slot.date === SAME_DAY)).toBe(true)
  })

  it('rejects a partially-overlapping second slot on the same date with DUPLICATE_BOOKING', async () => {
    const { bookings } = setupSameDayFixtures()

    const first = (await handler(validInput('10:00', '11:00'), authedContext())) as {
      bookingId: string
    }
    expect(first.bookingId).toBeDefined()
    expect(bookings).toHaveLength(1)

    let caught: { code?: string; details?: { error?: string } } | null = null
    try {
      await handler(validInput('10:30', '11:30'), authedContext())
    } catch (err: unknown) {
      caught = err as { code?: string; details?: { error?: string } }
    }

    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('already-exists')
    expect(caught?.details?.error).toBe('DUPLICATE_BOOKING')
    // No second row was written.
    expect(bookings).toHaveLength(1)
  })

  it('rejects an identical start/end second slot on the same date with DUPLICATE_BOOKING', async () => {
    const { bookings } = setupSameDayFixtures()

    const first = (await handler(validInput('10:00', '11:00'), authedContext())) as {
      bookingId: string
    }
    expect(first.bookingId).toBeDefined()
    expect(bookings).toHaveLength(1)

    let caught: { code?: string; details?: { error?: string } } | null = null
    try {
      await handler(validInput('10:00', '11:00'), authedContext())
    } catch (err: unknown) {
      caught = err as { code?: string; details?: { error?: string } }
    }

    expect(caught).not.toBeNull()
    expect(caught?.code).toBe('already-exists')
    expect(caught?.details?.error).toBe('DUPLICATE_BOOKING')
    expect(bookings).toHaveLength(1)
  })
})
