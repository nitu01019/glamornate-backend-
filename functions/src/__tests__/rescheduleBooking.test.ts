/**
 * Tests for the rescheduleBooking callable Cloud Function.
 *
 * rescheduleBooking performs the following transactionally:
 *   1. Read booking, verify ownership + state (must be confirmed or payment_pending).
 *   2. Read new availability doc and hold requested slot.
 *   3. Release the previously held slot on the old availability doc (if different).
 *   4. Update booking.slot, booking.scheduledAt, and push statusHistory entry.
 *
 * All external dependencies (firebase-admin, firebase-functions) are mocked
 * so tests run entirely in-process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted()
// ---------------------------------------------------------------------------

const {
  mockCollection,
  mockDocFn,
  mockRunTransaction,
  mockTxnUpdate,
} = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDocFn: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockTxnUpdate: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  // Per-collection doc factory so the production code receives DocRefs
  // that carry a `.path`. The same-doc detection in the handler
  // (oldAvailabilityRef.path === newAvailabilityRef.path) requires this.
  const collection = mockCollection.mockImplementation((collectionName: string) => ({
    doc: (docId: string) => mockDocFn(docId, collectionName),
  }))

  const firestoreInstance = {
    collection,
    runTransaction: mockRunTransaction,
  }

  const firestoreFn = () => firestoreInstance
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 1700000000, toDate: () => new Date(1700000000000) }),
    fromDate: (d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), toDate: () => d }),
  }
  firestoreFn.FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    arrayUnion: (...args: unknown[]) => ({ _arrayUnion: args }),
  }

  return {
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
  }
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
  const https = {
    HttpsError,
    onCall: (handler: Function) => handler,
  }
  const runWith = () => ({
    https,
    region: () => ({ https }),
  })
  return {
    default: { runWith, https },
    runWith,
    https,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

vi.mock('../utils/error-handler', () => ({
  handleError: (err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err) return err
    return new Error('internal')
  },
}))

// Pass-through shim for Phase 2 withRateLimit wrapper. The real helper hits
// Firestore on every invocation; in tests it would require setting up an
// additional `_rateLimits` doc/transaction mock. Short-circuit it.
vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: <TData, TResult>(
    _opts: unknown,
    handler: (data: TData, ctx: unknown) => Promise<TResult>,
  ) => handler,
}))

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { rescheduleBooking } from '../callable/rescheduleBooking'

const handler = rescheduleBooking as unknown as (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return {
    bookingId: 'booking-1',
    newSlot: {
      date: '2026-05-10',
      start: '14:00',
      end: '15:00',
      duration: 60,
    },
    reason: 'Need a later slot',
  }
}

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

function defaultBooking(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-123',
    spaId: 'spa-1',
    therapistId: 'thr-1',
    bookingStatus: 'confirmed',
    slot: {
      date: '2026-05-09',
      start: '10:00',
      end: '11:00',
      duration: 60,
    },
    ...overrides,
  }
}

function defaultNewAvailabilitySlots(overrides: Record<string, unknown> = {}) {
  return [
    { start: '14:00', end: '15:00', available: true, bookingId: null, ...overrides },
  ]
}

function defaultOldAvailabilitySlots() {
  return [
    { start: '10:00', end: '11:00', available: false, bookingId: 'booking-1' },
  ]
}

interface HappyPathOpts {
  bookingOverrides?: Record<string, unknown>
  userRole?: string
  userSpaId?: string
  newSlotsData?: Array<Record<string, unknown>>
  newAvailExists?: boolean
  oldAvailExists?: boolean
  txnThrows?: Error
  // Same-doc case (Codex review fix): when caller wants old + new availability
  // to share a single in-memory `slots` array so the harness observes the
  // collapsed-update behaviour.
  sharedSlots?: Array<Record<string, unknown>>
  // 2026-05-14: overrides what the in-transaction re-read of the booking doc
  // returns. Used by the RESCHEDULE_CONFLICT precondition test.
  txnBookingDoc?: { exists: boolean; data: () => unknown }
}

function setupHappyPath(opts: HappyPathOpts = {}) {
  const bookingDoc = {
    exists: true,
    ref: { id: 'booking-1' },
    data: () => defaultBooking(opts.bookingOverrides),
  }

  const userDoc = {
    exists: true,
    data: () => ({
      role: opts.userRole ?? 'customer',
      spaData: opts.userSpaId ? { spaId: opts.userSpaId } : undefined,
    }),
  }

  // db.collection(...).doc(id).get(). Each ref gets a deterministic `.path`
  // so the handler can distinguish old- vs new-availability docs by identity.
  mockDocFn.mockImplementation((docId: string, collectionName?: string) => {
    const path = collectionName ? `${collectionName}/${docId}` : docId
    if (docId === 'booking-1') {
      return { path, get: () => Promise.resolve(bookingDoc) }
    }
    if (docId === 'user-123' || docId === 'owner-999') {
      return { path, get: () => Promise.resolve(userDoc) }
    }
    // availability + everything else
    return { path, get: () => Promise.resolve({ exists: false, data: () => null }) }
  })

  // runTransaction — simulates the atomic slot swap. Branches on `ref.path`
  // so callers can model both the different-doc case (old vs new availability
  // live on different dates) and the same-doc case (Codex review fix:
  // identical date+therapist composite id).
  mockRunTransaction.mockImplementation(async (cb: Function) => {
    if (opts.txnThrows) throw opts.txnThrows

    const newAvailPath = `availability/spa-1_2026-05-10_thr-1`
    const oldAvailPath = `availability/spa-1_2026-05-09_thr-1`

    // For the same-doc case the in-memory array is shared across reads/writes
    // so the test can observe the effect of multiple in-place mutations.
    const sharedSlots = opts.sharedSlots
    const newAvailDoc = {
      exists: opts.newAvailExists ?? true,
      data: () =>
        sharedSlots
          ? { slots: sharedSlots }
          : { slots: opts.newSlotsData ?? defaultNewAvailabilitySlots() },
    }
    const oldAvailDoc = {
      exists: opts.oldAvailExists ?? true,
      data: () =>
        sharedSlots
          ? { slots: sharedSlots }
          : { slots: defaultOldAvailabilitySlots() },
    }

    const txn = {
      get: vi.fn().mockImplementation((ref: any) => {
        const path: string = ref?.path ?? ''
        // 2026-05-14 (RESCHEDULE_CONFLICT precondition): the handler now
        // re-reads the booking doc as its first transactional read so it can
        // detect concurrent edits between the outer .get() and the txn start.
        if (path === 'bookings/booking-1') {
          return Promise.resolve(opts.txnBookingDoc ?? bookingDoc)
        }
        if (path === newAvailPath) return Promise.resolve(newAvailDoc)
        if (path === oldAvailPath) return Promise.resolve(oldAvailDoc)
        // Fallback: legacy ordering when paths are not present.
        return Promise.resolve(newAvailDoc)
      }),
      update: mockTxnUpdate,
    }

    return cb(txn)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rescheduleBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('reschedules a confirmed booking to a new slot on a different date', async () => {
      setupHappyPath()
      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true)
      expect(result.newSlot.date).toBe('2026-05-10')
      expect(result.newSlot.start).toBe('14:00')
    })

    // payment_pending state was removed in the Stripe removal (Wave 1, 2026-05-02);
    // only `confirmed` bookings are reschedulable now. The previous
    // `reschedules a payment_pending booking` case has been dropped.

    it('returns both oldSlot and newSlot in response envelope', async () => {
      setupHappyPath()
      const result = (await handler(validInput(), authedContext())) as any

      expect(result.oldSlot.date).toBe('2026-05-09')
      expect(result.oldSlot.start).toBe('10:00')
      expect(result.newSlot.date).toBe('2026-05-10')
    })

    it('performs all slot mutations inside a single transaction', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      expect(mockRunTransaction).toHaveBeenCalledTimes(1)
      // new avail hold + old avail release + booking update = 3 updates
      expect(mockTxnUpdate).toHaveBeenCalledTimes(3)
    })
  })

  // -----------------------------------------------------------------------
  // Failure modes
  // -----------------------------------------------------------------------

  describe('failure modes', () => {
    it('throws unauthenticated when context.auth is missing', async () => {
      await expect(handler(validInput(), { auth: undefined })).rejects.toThrow(
        'Authentication required'
      )
    })

    it('throws unauthenticated when auth object is absent entirely', async () => {
      await expect(handler(validInput(), {} as any)).rejects.toThrow(
        'Authentication required'
      )
    })

    it('throws on zod validation when date format is invalid', async () => {
      await expect(
        handler(
          {
            bookingId: 'booking-1',
            newSlot: { date: '05/10/2026', start: '14:00', end: '15:00', duration: 60 },
          },
          authedContext()
        )
      ).rejects.toThrow()
    })

    it('throws on zod validation when start time format is invalid', async () => {
      await expect(
        handler(
          {
            bookingId: 'booking-1',
            newSlot: { date: '2026-05-10', start: '2pm', end: '15:00', duration: 60 },
          },
          authedContext()
        )
      ).rejects.toThrow()
    })

    it('throws not-found when booking does not exist', async () => {
      mockDocFn.mockImplementation(() => ({
        get: () => Promise.resolve({ exists: false, data: () => null }),
      }))

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Booking not found'
      )
    })

    it('throws permission-denied when caller is neither booking owner nor spa staff', async () => {
      setupHappyPath({
        bookingOverrides: { userId: 'other-user', spaId: 'spa-1' },
        // authed user has no spaData for spa-1 and is not the booking owner
      })

      await expect(handler(validInput(), authedContext('user-123'))).rejects.toThrow(
        'Not authorized to reschedule this booking'
      )
    })

    it('throws failed-precondition when booking is in cancelled state', async () => {
      setupHappyPath({ bookingOverrides: { bookingStatus: 'cancelled' } })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Booking cannot be rescheduled'
      )
    })

    it('throws failed-precondition when booking is in completed state', async () => {
      setupHappyPath({ bookingOverrides: { bookingStatus: 'completed' } })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Booking cannot be rescheduled'
      )
    })

    it('warns and proceeds with booking update when new availability doc is missing', async () => {
      // 2026-05-14: behaviour changed — missing availability doc now mirrors
      // createBooking.ts:69-72 (warn-and-proceed) instead of throwing
      // 'Availability data not found'. The booking doc is the source of
      // truth; availability is a cache that the scheduled recalculate job
      // backfills. Throwing here was the prod-visible "resource not found"
      // bug — see [[booking_flow_overhaul_2026_05_13]] follow-up.
      setupHappyPath({ newAvailExists: false })

      const result = (await handler(validInput(), authedContext())) as any
      expect(result.success).toBe(true)
      expect(result.newSlot.start).toBe('14:00')
      // Exactly one update — the booking doc write. No availability writes
      // because the availability doc didn't exist.
      const availUpdates = mockTxnUpdate.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).slots !== undefined,
      )
      expect(availUpdates).toHaveLength(0)
    })

    it('throws aborted when requested slot is not available (already taken)', async () => {
      setupHappyPath({
        newSlotsData: [
          { start: '14:00', end: '15:00', available: false, bookingId: 'other-booking' },
        ],
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Selected time slot is no longer available'
      )
    })

    it('rolls back when transaction throws (e.g., contention)', async () => {
      setupHappyPath({ txnThrows: new Error('Firestore transaction conflict') })

      await expect(handler(validInput(), authedContext())).rejects.toThrow()
      expect(mockTxnUpdate).not.toHaveBeenCalled()
    })

    // 2026-05-14: the production "resource not found" bug surfaced when
    // booking.therapistId was null (no therapist selected at create time).
    // The availability composite-key `${spaId}_${date}_null` never exists,
    // so the old code threw 'not-found' from the txn body. The fix skips
    // availability hold/release entirely when therapistId is null —
    // mirroring createBooking.ts:52-74's optional-therapist guard.
    it('reschedules successfully when booking has null therapistId', async () => {
      setupHappyPath({ bookingOverrides: { therapistId: null } })

      const result = (await handler(validInput(), authedContext())) as any
      expect(result.success).toBe(true)
      expect(result.newSlot.start).toBe('14:00')

      // No availability writes — the entire if (therapistId) block was
      // skipped. Exactly one update happened: the booking doc itself.
      const availUpdates = mockTxnUpdate.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).slots !== undefined,
      )
      expect(availUpdates).toHaveLength(0)
    })

    // 2026-05-14: RESCHEDULE_CONFLICT precondition — when the booking doc's
    // updatedAt timestamp differs between the outer .get() and the
    // transaction's re-read, another session has rescheduled in the gap.
    // We must abort instead of silently overwriting.
    it('rejects with RESCHEDULE_CONFLICT when booking updatedAt changes mid-transaction', async () => {
      const tsA = {
        seconds: 1700000000,
        toDate: () => new Date(1700000000000),
        isEqual: (other: any) =>
          !!other && typeof other.seconds === 'number' && other.seconds === 1700000000,
      }
      const tsB = {
        seconds: 1700000099,
        toDate: () => new Date(1700000099000),
        isEqual: (other: any) =>
          !!other && typeof other.seconds === 'number' && other.seconds === 1700000099,
      }
      const outerBookingDoc = {
        exists: true,
        ref: { id: 'booking-1' },
        data: () => defaultBooking({ updatedAt: tsA }),
      }
      const txnBookingDoc = {
        exists: true,
        data: () => defaultBooking({ updatedAt: tsB }),
      }
      // Override mockDocFn so the outer .get() sees tsA on the booking doc.
      mockDocFn.mockImplementation((docId: string, collectionName?: string) => {
        const path = collectionName ? `${collectionName}/${docId}` : docId
        if (docId === 'booking-1') {
          return { path, get: () => Promise.resolve(outerBookingDoc) }
        }
        if (docId === 'user-123') {
          return {
            path,
            get: () =>
              Promise.resolve({
                exists: true,
                data: () => ({ role: 'customer', spaData: undefined }),
              }),
          }
        }
        return {
          path,
          get: () => Promise.resolve({ exists: false, data: () => null }),
        }
      })
      // runTransaction returns the txn-time doc with tsB on the booking
      // re-read, triggering the precondition mismatch.
      mockRunTransaction.mockImplementation(async (cb: Function) => {
        const txn = {
          get: vi.fn().mockImplementation((ref: any) => {
            const path: string = ref?.path ?? ''
            if (path === 'bookings/booking-1') return Promise.resolve(txnBookingDoc)
            return Promise.resolve({ exists: true, data: () => ({ slots: [] }) })
          }),
          update: mockTxnUpdate,
        }
        return cb(txn)
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        /RESCHEDULE_CONFLICT|modified by another session/,
      )
    })
  })

  // -----------------------------------------------------------------------
  // Idempotency / side-effect assertions
  // -----------------------------------------------------------------------

  describe('side-effect assertions', () => {
    it('holds the new slot by marking it available=false with the booking id', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      // First update call is the new-availability hold
      const firstUpdateArgs = mockTxnUpdate.mock.calls[0][1]
      expect(firstUpdateArgs.slots[0].available).toBe(false)
      expect(firstUpdateArgs.slots[0].bookingId).toBe('booking-1')
    })

    it('releases the old slot by flipping available=true and nulling bookingId', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      // Second update call is the old-availability release
      const secondUpdateArgs = mockTxnUpdate.mock.calls[1][1]
      expect(secondUpdateArgs.slots[0].available).toBe(true)
      expect(secondUpdateArgs.slots[0].bookingId).toBe(null)
    })
  })

  // -----------------------------------------------------------------------
  // Same-doc collapse (Codex review fix)
  //
  // Reproduces the bug where rescheduling within the SAME date + therapist
  // (so old + new slots map to the SAME availability doc) issued two
  // `transaction.update(ref, { slots })` calls. Firestore replaces the
  // whole field on each update, so the second update overwrote the first —
  // losing the new-slot hold AND leaving the old slot held. The fix
  // collapses both mutations into a single update on a shared array.
  // -----------------------------------------------------------------------

  describe('same-day same-therapist reschedule (codex review fix)', () => {
    function sameDayInput() {
      return {
        bookingId: 'booking-1',
        // Same date as the existing booking; only the time changes.
        newSlot: {
          date: '2026-05-09',
          start: '14:00',
          end: '15:00',
          duration: 60,
        },
        reason: 'Earlier start same day',
      }
    }

    it('issues exactly one availability update when old + new slots share a doc', async () => {
      // Single in-memory slots array containing BOTH the held old slot
      // (10:00, bookingId=booking-1) and the available new slot (14:00).
      const sharedSlots: Array<Record<string, unknown>> = [
        { start: '10:00', end: '11:00', available: false, bookingId: 'booking-1' },
        { start: '14:00', end: '15:00', available: true, bookingId: null },
      ]
      setupHappyPath({ sharedSlots })

      // Override mockDocFn so both old and new availability docs resolve
      // to the SAME path — that is what triggers the same-doc branch.
      const sameAvailPath = 'availability/spa-1_2026-05-09_thr-1'
      const bookingDoc = {
        exists: true,
        ref: { id: 'booking-1' },
        data: () => defaultBooking(),
      }
      const userDoc = {
        exists: true,
        data: () => ({ role: 'customer', spaData: undefined }),
      }
      mockDocFn.mockImplementation((docId: string, collectionName?: string) => {
        if (docId === 'booking-1') {
          return { path: 'bookings/booking-1', get: () => Promise.resolve(bookingDoc) }
        }
        if (docId === 'user-123') {
          return { path: 'users/user-123', get: () => Promise.resolve(userDoc) }
        }
        // All availability lookups (old + new) collapse to the same path
        // because the date and therapistId are identical.
        if (collectionName === 'availability') {
          return {
            path: sameAvailPath,
            get: () =>
              Promise.resolve({
                exists: true,
                data: () => ({ slots: sharedSlots }),
              }),
          }
        }
        return { path: docId, get: () => Promise.resolve({ exists: false, data: () => null }) }
      })

      const result = (await handler(sameDayInput(), authedContext())) as any
      expect(result.success).toBe(true)

      // Filter to availability updates only (booking update has no `slots`).
      const availUpdates = mockTxnUpdate.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).slots !== undefined,
      )
      // BEFORE the fix: 2 availability updates → second clobbers the first.
      // AFTER  the fix: exactly 1 combined availability update.
      expect(availUpdates).toHaveLength(1)

      // The single update must reflect BOTH mutations in one slots array:
      // new slot held, old slot released.
      const finalSlots = (availUpdates[0][1] as { slots: any[] }).slots
      const newSlot = finalSlots.find((s) => s.start === '14:00')
      const oldSlot = finalSlots.find((s) => s.start === '10:00')

      expect(newSlot.available).toBe(false)
      expect(newSlot.bookingId).toBe('booking-1')
      expect(oldSlot.available).toBe(true)
      expect(oldSlot.bookingId).toBe(null)
    })

    it('still issues two updates when old + new slots live on different docs', async () => {
      // Sanity check: the original (different-doc) two-update path is preserved.
      setupHappyPath()
      await handler(validInput(), authedContext())

      const availUpdates = mockTxnUpdate.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).slots !== undefined,
      )
      expect(availUpdates).toHaveLength(2)
    })

    it('preserves the slot-collision error path when the new slot is already held', async () => {
      // Same-day reschedule but the requested new slot is already taken by
      // a different booking → must still throw `aborted`.
      const sharedSlots: Array<Record<string, unknown>> = [
        { start: '10:00', end: '11:00', available: false, bookingId: 'booking-1' },
        { start: '14:00', end: '15:00', available: false, bookingId: 'someone-else' },
      ]
      setupHappyPath({ sharedSlots })

      const sameAvailPath = 'availability/spa-1_2026-05-09_thr-1'
      const bookingDoc = {
        exists: true,
        ref: { id: 'booking-1' },
        data: () => defaultBooking(),
      }
      const userDoc = {
        exists: true,
        data: () => ({ role: 'customer', spaData: undefined }),
      }
      mockDocFn.mockImplementation((docId: string, collectionName?: string) => {
        if (docId === 'booking-1') {
          return { path: 'bookings/booking-1', get: () => Promise.resolve(bookingDoc) }
        }
        if (docId === 'user-123') {
          return { path: 'users/user-123', get: () => Promise.resolve(userDoc) }
        }
        if (collectionName === 'availability') {
          return {
            path: sameAvailPath,
            get: () =>
              Promise.resolve({
                exists: true,
                data: () => ({ slots: sharedSlots }),
              }),
          }
        }
        return { path: docId, get: () => Promise.resolve({ exists: false, data: () => null }) }
      })

      await expect(handler(sameDayInput(), authedContext())).rejects.toThrow(
        'Selected time slot is no longer available',
      )
      // No availability updates may be issued before the abort.
      const availUpdates = mockTxnUpdate.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).slots !== undefined,
      )
      expect(availUpdates).toHaveLength(0)
    })
  })
})
