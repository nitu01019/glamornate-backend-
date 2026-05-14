/**
 * Tests for the checkInCustomer callable Cloud Function.
 *
 * Locks Phase 3.7 booking-test priorities:
 *  - Auth rejection (unauthenticated bookings cannot transition).
 *  - Validation rejection (missing bookingId).
 *  - Permission gate: only spa staff (matching spaData.spaId) OR the booking's
 *    own customer may transition confirmed → en_route.
 *  - State precondition: only `confirmed` bookings can be checked in.
 *  - Audit log write: statusHistory entry is appended via FieldValue.arrayUnion
 *    with the correct from/to/actor fields.
 *
 * All firebase-* deps are mocked — no emulator required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDocFn } = vi.hoisted(() => ({
  mockDocFn: vi.fn(),
}))

vi.mock('firebase-admin', () => {
  const collection = vi.fn().mockImplementation(() => ({ doc: mockDocFn }))

  const firestoreInstance = { collection }

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
  const runWith = () => ({ https, region: () => ({ https }) })
  return {
    default: { runWith, https },
    runWith,
    https,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
})

vi.mock('../utils/error-handler', () => ({
  handleError: (err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err) return err
    return new Error('internal')
  },
}))

vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: <TData, TResult>(
    _opts: unknown,
    handler: (data: TData, ctx: unknown) => Promise<TResult>,
  ) => handler,
}))

import { checkInCustomer } from '../callable/checkInCustomer'

const handler = checkInCustomer as unknown as (
  data: unknown,
  context: { auth?: { uid: string } },
) => Promise<unknown>

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

interface DocOverrides {
  booking?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
  bookingExists?: boolean
}

function setupDocs(overrides: DocOverrides = {}) {
  const mockUpdate = vi.fn().mockResolvedValue(undefined)

  const bookingExists = overrides.bookingExists ?? true
  const bookingData = overrides.booking ?? {
    userId: 'user-123',
    spaId: 'spa-1',
    bookingStatus: 'confirmed',
  }
  const userData = overrides.user ?? null

  const bookingRef = {
    update: mockUpdate,
  }
  const bookingDoc = {
    exists: bookingExists,
    ref: bookingRef,
    data: () => bookingData,
  }

  const userDoc = {
    exists: userData !== null,
    data: () => userData ?? undefined,
  }

  mockDocFn.mockImplementation((docId: string) => {
    if (docId === 'booking-1') {
      return { get: () => Promise.resolve(bookingDoc) }
    }
    return { get: () => Promise.resolve(userDoc) }
  })

  return { mockUpdate, bookingRef }
}

describe('checkInCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---- Authentication ----

  it('rejects unauthenticated calls', async () => {
    await expect(
      handler({ bookingId: 'booking-1' }, { auth: undefined }),
    ).rejects.toThrow('Authentication required')
  })

  // ---- Validation ----

  it('rejects when bookingId is missing', async () => {
    await expect(handler({}, authedContext())).rejects.toThrow(
      'bookingId is required',
    )
  })

  it('rejects when booking does not exist', async () => {
    setupDocs({ bookingExists: false })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext()),
    ).rejects.toThrow('Booking not found')
  })

  // ---- Permission gate ----

  it('rejects when caller is neither customer nor spa staff for that spa', async () => {
    setupDocs({
      booking: { userId: 'other-user', spaId: 'spa-1', bookingStatus: 'confirmed' },
      user: { spaData: { spaId: 'spa-2' } }, // spa-2 staff cannot touch spa-1 booking
    })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext('user-123')),
    ).rejects.toThrow('Not authorized to check in this booking')
  })

  // ---- State precondition ----

  it('rejects when booking status is not confirmed', async () => {
    setupDocs({
      booking: { userId: 'user-123', spaId: 'spa-1', bookingStatus: 'in_progress' },
    })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext('user-123')),
    ).rejects.toThrow('Booking is not confirmed')
  })

  it('rejects when booking is already cancelled', async () => {
    setupDocs({
      booking: { userId: 'user-123', spaId: 'spa-1', bookingStatus: 'cancelled' },
    })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext('user-123')),
    ).rejects.toThrow('Booking is not confirmed')
  })

  // ---- Happy path ----

  it('transitions confirmed → en_route as the booking customer', async () => {
    const { mockUpdate } = setupDocs({
      booking: { userId: 'user-123', spaId: 'spa-1', bookingStatus: 'confirmed' },
    })
    const result = await handler(
      { bookingId: 'booking-1' },
      authedContext('user-123'),
    )
    expect(result).toEqual({ success: true })
    expect(mockUpdate).toHaveBeenCalledTimes(1)

    const patch = mockUpdate.mock.calls[0][0]
    expect(patch.bookingStatus).toBe('en_route')
    expect(patch.checkIn.checkedInBy).toBe('user-123')
    // Audit log: statusHistory uses arrayUnion with the right transition.
    const arrayUnionPayload = patch.statusHistory._arrayUnion[0]
    expect(arrayUnionPayload.status).toBe('en_route')
    expect(arrayUnionPayload.from).toBe('confirmed')
    expect(arrayUnionPayload.to).toBe('en_route')
    expect(arrayUnionPayload.actor).toBe('customer')
    expect(arrayUnionPayload.actorId).toBe('user-123')
  })

  it('transitions confirmed → en_route as spa staff (actor=spa)', async () => {
    const { mockUpdate } = setupDocs({
      booking: { userId: 'other-user', spaId: 'spa-1', bookingStatus: 'confirmed' },
      user: { spaData: { spaId: 'spa-1' } },
    })
    const result = await handler(
      { bookingId: 'booking-1' },
      authedContext('staff-1'),
    )
    expect(result).toEqual({ success: true })

    const patch = mockUpdate.mock.calls[0][0]
    expect(patch.bookingStatus).toBe('en_route')
    expect(patch.checkIn.checkedInBy).toBe('staff-1')
    const arrayUnionPayload = patch.statusHistory._arrayUnion[0]
    expect(arrayUnionPayload.actor).toBe('spa')
    expect(arrayUnionPayload.actorId).toBe('staff-1')
  })
})
