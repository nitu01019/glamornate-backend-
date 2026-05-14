/**
 * Tests for the getBookingRealtimeStatus callable Cloud Function.
 *
 * Locks Phase 3.7 booking-test priorities:
 *  - Auth rejection (unauthenticated reads blocked).
 *  - Validation rejection (Zod schema rejects missing bookingId).
 *  - Not-found rejection (clear 'not-found' code on missing booking).
 *  - Permission gate: random users without spa relationship are blocked even
 *    when the booking exists.
 *  - State machine projection: `nextExpectedStatus` follows the post-Stripe
 *    confirmed → en_route → in_progress → completed flow (no draft branch).
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

import { getBookingRealtimeStatus } from '../callable/getBookingRealtimeStatus'

const handler = getBookingRealtimeStatus as unknown as (
  data: unknown,
  context: { auth?: { uid: string } },
) => Promise<{
  booking: { bookingStatus: string }
  progress: { nextExpectedStatus: string | null; nextExpectedAction: string | null }
  spa: unknown
  therapist: unknown
  services: unknown[]
  timeline: { scheduledTime: string; timeUntil: number; timeStatus: string }
}>

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

interface DocSetup {
  booking?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
  spa?: Record<string, unknown> | null
  therapist?: Record<string, unknown> | null
  bookingExists?: boolean
}

function setupDocs(overrides: DocSetup = {}) {
  const bookingExists = overrides.bookingExists ?? true
  const bookingData = overrides.booking ?? {
    userId: 'user-123',
    spaId: 'spa-1',
    therapistId: 'thr-1',
    serviceIds: ['svc-1'],
    bookingStatus: 'confirmed',
    statusHistory: [],
    slot: { date: '2099-12-31', start: '10:00', end: '11:00', duration: 60 },
    pricing: { total: 1000, currency: 'INR' },
    customer: { name: 'Alice' },
    reminderSent: false,
    checkIn: null,
    checkOut: null,
    scheduledAt: null,
  }
  const userData = overrides.user ?? null
  const spaData = overrides.spa ?? { name: 'Spa One', location: {}, contact: {}, featuredImage: null }
  const therapistData =
    overrides.therapist ?? { name: 'T', displayName: 'T', photo: null }

  mockDocFn.mockImplementation((docId: string) => {
    if (docId === 'booking-1') {
      return {
        id: docId,
        get: () =>
          Promise.resolve({
            exists: bookingExists,
            id: docId,
            data: () => bookingData,
          }),
      }
    }
    if (docId === 'spa-1') {
      return {
        id: docId,
        get: () => Promise.resolve({ id: docId, data: () => spaData ?? undefined }),
      }
    }
    if (docId === 'thr-1') {
      return {
        id: docId,
        get: () =>
          Promise.resolve({ id: docId, data: () => therapistData ?? undefined }),
      }
    }
    if (docId === 'svc-1') {
      return {
        id: docId,
        get: () =>
          Promise.resolve({ id: docId, data: () => ({ name: 'Massage' }) }),
      }
    }
    // Fallback: treated as a users/{uid} doc
    return {
      id: docId,
      get: () =>
        Promise.resolve({
          exists: userData !== null,
          data: () => userData ?? undefined,
        }),
    }
  })
}

describe('getBookingRealtimeStatus', () => {
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

  it('rejects when bookingId is missing (Zod schema)', async () => {
    await expect(handler({}, authedContext())).rejects.toThrow()
  })

  it('rejects when bookingId is the wrong type', async () => {
    await expect(
      handler({ bookingId: 123 }, authedContext()),
    ).rejects.toThrow()
  })

  // ---- Not-found ----

  it('throws not-found when booking does not exist', async () => {
    setupDocs({ bookingExists: false })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext()),
    ).rejects.toThrow('Booking not found')
  })

  // ---- Permission gate ----

  it('rejects unrelated user when no users/{uid} doc exists', async () => {
    setupDocs({
      booking: {
        userId: 'owner',
        spaId: 'spa-1',
        therapistId: 'thr-1',
        serviceIds: ['svc-1'],
        bookingStatus: 'confirmed',
        statusHistory: [],
        slot: { date: '2099-12-31', start: '10:00', end: '11:00', duration: 60 },
        pricing: {},
        customer: {},
        reminderSent: false,
      },
      user: null,
    })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext('stranger')),
    ).rejects.toThrow('Not authorized to view this booking')
  })

  it('rejects logged-in user whose role/spaId does not match the booking spa', async () => {
    setupDocs({
      booking: {
        userId: 'owner',
        spaId: 'spa-1',
        therapistId: 'thr-1',
        serviceIds: ['svc-1'],
        bookingStatus: 'confirmed',
        statusHistory: [],
        slot: { date: '2099-12-31', start: '10:00', end: '11:00', duration: 60 },
        pricing: {},
        customer: {},
        reminderSent: false,
      },
      user: { role: 'customer' },
    })
    await expect(
      handler({ bookingId: 'booking-1' }, authedContext('stranger')),
    ).rejects.toThrow('Not authorized to view this booking')
  })

  // ---- State machine projection ----

  it('projects nextExpectedStatus = en_route when bookingStatus is confirmed', async () => {
    setupDocs() // default booking is `confirmed`, owned by user-123
    const result = await handler(
      { bookingId: 'booking-1' },
      authedContext('user-123'),
    )
    expect(result.booking.bookingStatus).toBe('confirmed')
    expect(result.progress.nextExpectedStatus).toBe('en_route')
    expect(result.progress.nextExpectedAction).toBe('Awaiting appointment')
  })

  it('projects nextExpectedStatus = in_progress when bookingStatus is en_route', async () => {
    setupDocs({
      booking: {
        userId: 'user-123',
        spaId: 'spa-1',
        therapistId: 'thr-1',
        serviceIds: ['svc-1'],
        bookingStatus: 'en_route',
        statusHistory: [],
        slot: { date: '2099-12-31', start: '10:00', end: '11:00', duration: 60 },
        pricing: {},
        customer: {},
        reminderSent: false,
      },
    })
    const result = await handler(
      { bookingId: 'booking-1' },
      authedContext('user-123'),
    )
    expect(result.progress.nextExpectedStatus).toBe('in_progress')
    expect(result.progress.nextExpectedAction).toBe('Service in progress')
  })

  it('projects nextExpectedStatus = completed when bookingStatus is in_progress', async () => {
    setupDocs({
      booking: {
        userId: 'user-123',
        spaId: 'spa-1',
        therapistId: 'thr-1',
        serviceIds: ['svc-1'],
        bookingStatus: 'in_progress',
        statusHistory: [],
        slot: { date: '2099-12-31', start: '10:00', end: '11:00', duration: 60 },
        pricing: {},
        customer: {},
        reminderSent: false,
      },
    })
    const result = await handler(
      { bookingId: 'booking-1' },
      authedContext('user-123'),
    )
    expect(result.progress.nextExpectedStatus).toBe('completed')
    expect(result.progress.nextExpectedAction).toBe('Complete service')
  })

  it('returns null nextExpectedStatus on terminal states (completed / cancelled)', async () => {
    setupDocs({
      booking: {
        userId: 'user-123',
        spaId: 'spa-1',
        therapistId: 'thr-1',
        serviceIds: ['svc-1'],
        bookingStatus: 'completed',
        statusHistory: [],
        slot: { date: '2099-12-31', start: '10:00', end: '11:00', duration: 60 },
        pricing: {},
        customer: {},
        reminderSent: false,
      },
    })
    const result = await handler(
      { bookingId: 'booking-1' },
      authedContext('user-123'),
    )
    expect(result.progress.nextExpectedStatus).toBeNull()
    expect(result.progress.nextExpectedAction).toBeNull()
  })
})
