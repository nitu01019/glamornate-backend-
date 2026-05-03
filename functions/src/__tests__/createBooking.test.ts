/**
 * Tests for the createBooking callable Cloud Function.
 *
 * All external dependencies (firebase-admin, firebase-functions, logger) are
 * mocked so the tests run entirely in-process without network or emulator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted() — these variables are available inside vi.mock factories
// ---------------------------------------------------------------------------

const {
  mockGet: _mockGet,
  mockSet,
  mockUpdate,
  mockGetAll,
  mockRunTransaction,
  mockDocFn,
  mockWhere,
  GENERATED_BOOKING_ID,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetAll: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockDocFn: vi.fn(),
  mockWhere: vi.fn(),
  GENERATED_BOOKING_ID: 'booking-abc-123',
}))

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../utils/error-handler', () => ({
  handleError: (err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err) return err
    return new Error('internal')
  },
}))

// Pass-through shim for Phase 3 Wave B withRateLimit wrapper. The real helper
// hits Firestore on every invocation; in tests it would require setting up
// an additional `_rateLimits` doc/transaction mock. Short-circuit it.
vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (_opts: unknown, fn: Function) => fn,
}))

// ---------------------------------------------------------------------------
// Import the function under test
// ---------------------------------------------------------------------------

import { createBooking } from '../callable/createBooking'

// The onCall mock returns the handler directly
const handler = createBooking as unknown as (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return {
    spaId: 'spa-1',
    therapistId: 'therapist-1',
    serviceIds: ['svc-1'],
    addonIds: ['addon-1'],
    slot: {
      date: '2027-06-15',
      start: '10:00',
      end: '11:00',
      duration: 60,
    },
    notes: 'Please use lavender oil',
  }
}

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

/** Configure mocks for the happy-path scenario. */
function setupHappyPath() {
  const availabilityRef = { id: 'avail-ref' }
  const availabilityDoc = {
    exists: true,
    ref: availabilityRef,
    data: () => ({
      slots: [
        { start: '10:00', end: '11:00', available: true },
        { start: '11:00', end: '12:00', available: true },
      ],
    }),
  }

  const overlappingQuery = { docs: [] }

  const spaServiceDoc = {
    exists: true,
    data: () => ({ priceOverride: 1500 }),
  }

  const globalServiceDoc = {
    exists: true,
    data: () => ({ basePrice: 1200 }),
  }

  const addonDoc = {
    exists: true,
    id: 'addon-1',
    data: () => ({ name: 'Hot Stones', price: 500 }),
  }

  const bookingRef = { id: GENERATED_BOOKING_ID }

  mockDocFn.mockImplementation((docId?: string) => {
    if (!docId) return bookingRef
    if (docId.startsWith('spa-1_')) {
      return { get: () => Promise.resolve(availabilityDoc), ...availabilityRef }
    }
    return { get: () => Promise.resolve({ exists: false, data: () => null }) }
  })

  // The overlap query is now built as
  //   .where(...).where(...).where(...).limit(20)
  // and is passed to `txn.get(query)` inside the transaction. The chain is
  // tagged with `__overlapQuery` so the txn-get mock can recognise it and
  // return the overlap candidates. `limit` returns the same chain object so
  // chaining off of it still works.
  const overlapChain: Record<string, unknown> = { __overlapQuery: true }
  overlapChain.limit = vi.fn().mockReturnValue(overlapChain)
  overlapChain.get = () => Promise.resolve(overlappingQuery)
  mockWhere.mockReturnValue({
    where: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(overlapChain),
    }),
  })

  mockGetAll
    .mockResolvedValueOnce([spaServiceDoc])
    .mockResolvedValueOnce([globalServiceDoc])
    .mockResolvedValueOnce([addonDoc])

  // The transaction now reads (a) the availability doc ref AND (b) the
  // overlap query. Branch on whether the argument is the tagged overlap
  // chain so each receives the correct fixture.
  mockRunTransaction.mockImplementation(async (cb: Function) => {
    const transaction = {
      get: vi.fn().mockImplementation((arg: unknown) => {
        if ((arg as { __overlapQuery?: boolean })?.__overlapQuery) {
          return Promise.resolve(overlappingQuery)
        }
        return Promise.resolve({
          exists: true,
          data: () => ({
            slots: [{ start: '10:00', end: '11:00', available: true }],
          }),
        })
      }),
      update: mockUpdate,
      set: mockSet,
    }
    return cb(transaction)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TAX_RATE_PERCENT = '18'
    process.env.PLATFORM_FEE_PERCENT = '20'
  })

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  it('should reject unauthenticated calls', async () => {
    await expect(handler(validInput(), { auth: undefined })).rejects.toThrow(
      'Authentication required'
    )
  })

  it('should reject when auth object is missing entirely', async () => {
    await expect(handler(validInput(), {} as any)).rejects.toThrow(
      'Authentication required'
    )
  })

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  it('should reject invalid date format (non YYYY-MM-DD)', async () => {
    const data = { ...validInput(), slot: { ...validInput().slot, date: '15-06-2025' } }
    await expect(handler(data, authedContext())).rejects.toThrow()
  })

  it('should reject invalid time format (non HH:MM)', async () => {
    const data = { ...validInput(), slot: { ...validInput().slot, start: '9:00' } }
    await expect(handler(data, authedContext())).rejects.toThrow()
  })

  it('should reject when spaId is missing', async () => {
    const { spaId: _omit, ...rest } = validInput()
    await expect(handler(rest, authedContext())).rejects.toThrow()
  })

  it('should reject when serviceIds is missing', async () => {
    const { serviceIds: _omit, ...rest } = validInput()
    await expect(handler(rest, authedContext())).rejects.toThrow()
  })

  it('should reject when therapistId is missing', async () => {
    const { therapistId: _omit, ...rest } = validInput()
    await expect(handler(rest, authedContext())).rejects.toThrow()
  })

  it('should reject when slot is entirely missing', async () => {
    const { slot: _omit, ...rest } = validInput()
    await expect(handler(rest, authedContext())).rejects.toThrow()
  })

  it('should reject when slot.duration is zero or negative', async () => {
    const data = { ...validInput(), slot: { ...validInput().slot, duration: 0 } }
    await expect(handler(data, authedContext())).rejects.toThrow()
  })

  it('should accept request without optional addonIds', async () => {
    setupHappyPath()
    const data = { ...validInput() }
    delete (data as any).addonIds

    mockGetAll.mockReset()
    mockGetAll
      .mockResolvedValueOnce([{ exists: true, data: () => ({ priceOverride: 1500 }) }])
      .mockResolvedValueOnce([{ exists: true, data: () => ({ basePrice: 1200 }) }])

    const result = await handler(data, authedContext())
    expect((result as any).success).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Slot availability
  // -----------------------------------------------------------------------

  it('should skip availability check and proceed when availability document does not exist (fail-safe)', async () => {
    // Phase 3 Wave B/C landed fail-safe behavior: when no availability doc
    // exists (early-stage spa, no seed data), the slot check is skipped with
    // a logger.warn and the booking proceeds. Enforcement resumes once the
    // availability doc is seeded.
    //
    // Phase 3 A3.1 (race fix) further wraps even the no-availability path in
    // a transaction so the user-overlap re-check is TOCTOU-safe — so
    // runTransaction IS called in this branch now.
    setupHappyPath()

    // Override mockDocFn: availability composite-id lookup returns non-existent,
    // while the booking ref (no-arg doc()) still supports set(), and the user
    // ref still supports get().
    const bookingRef = { id: GENERATED_BOOKING_ID, set: mockSet }
    mockDocFn.mockImplementation((docId?: string) => {
      if (!docId) return bookingRef
      if (docId.startsWith('spa-1_')) {
        // Availability composite-id lookup returns "not found"
        return { get: () => Promise.resolve({ exists: false, data: () => null }) }
      }
      // Default (e.g. user profile lookup)
      return { get: () => Promise.resolve({ exists: false, data: () => null }) }
    })

    const result = await handler(validInput(), authedContext())
    expect((result as any).success).toBe(true)
    expect((result as any).bookingId).toBe(GENERATED_BOOKING_ID)

    // runTransaction IS called now even on the no-availability path so the
    // overlap re-check is part of the transaction read-set.
    expect(mockRunTransaction).toHaveBeenCalledTimes(1)

    // The transactional set() path should have been used.
    expect(mockSet).toHaveBeenCalled()
  })

  it('should reject when the requested slot is unavailable', async () => {
    const availabilityDoc = {
      exists: true,
      ref: { id: 'avail-ref' },
      data: () => ({
        slots: [{ start: '10:00', end: '11:00', available: false }],
      }),
    }

    mockDocFn.mockImplementation(() => ({
      get: () => Promise.resolve(availabilityDoc),
    }))

    await expect(handler(validInput(), authedContext())).rejects.toThrow(
      'This time slot is no longer available'
    )
  })

  it('should reject when no slot matches the requested time', async () => {
    const availabilityDoc = {
      exists: true,
      ref: { id: 'avail-ref' },
      data: () => ({
        slots: [{ start: '14:00', end: '15:00', available: true }],
      }),
    }

    mockDocFn.mockImplementation(() => ({
      get: () => Promise.resolve(availabilityDoc),
    }))

    await expect(handler(validInput(), authedContext())).rejects.toThrow(
      'This time slot is no longer available'
    )
  })

  // -----------------------------------------------------------------------
  // Pricing calculation
  // -----------------------------------------------------------------------

  it('should calculate pricing server-side from service and addon prices', async () => {
    setupHappyPath()
    const result = (await handler(validInput(), authedContext())) as any

    expect(result.pricing.services).toBe(1500)
    expect(result.pricing.addons).toBe(500)
  })

  it('should apply tax rate and platform fee correctly (18% tax, 20% fee)', async () => {
    setupHappyPath()
    const result = (await handler(validInput(), authedContext())) as any

    const servicesTotal = 1500
    const addonsTotal = 500
    const totalPrice = servicesTotal + addonsTotal

    const expectedTax = totalPrice * 0.18
    const expectedPlatformFee = Math.round(totalPrice * 0.20)
    const expectedTotal = totalPrice + expectedTax + expectedPlatformFee

    expect(result.pricing.tax).toBe(expectedTax)
    expect(result.pricing.platformFee).toBe(expectedPlatformFee)
    expect(result.pricing.total).toBe(expectedTotal)
    expect(result.pricing.currency).toBe('INR')
    expect(result.pricing.discount).toBe(0)
  })

  it('should use global basePrice when spa priceOverride is not set', async () => {
    setupHappyPath()

    mockGetAll.mockReset()
    mockGetAll
      .mockResolvedValueOnce([{ exists: true, data: () => ({}) }])
      .mockResolvedValueOnce([{ exists: true, data: () => ({ basePrice: 800 }) }])
      .mockResolvedValueOnce([{ exists: true, id: 'addon-1', data: () => ({ name: 'Stones', price: 200 }) }])

    // Wave 9C (Booking Flow Fix v3.1, 2026-05-02) — when the global
    // catalog fallback resolves a price, the source verifies the spa
    // *offers* the service via either (a) `spas/{spaId}.services` array
    // or (b) `spas/{spaId}/services/{serviceId}` subcollection doc.
    // Override mockDocFn so the spa doc lookup returns `services: ['svc-1']`,
    // satisfying branch (a).
    const bookingRef = { id: GENERATED_BOOKING_ID }
    const availabilityDoc = {
      exists: true,
      ref: { id: 'avail-ref' },
      data: () => ({
        slots: [{ start: '10:00', end: '11:00', available: true }],
      }),
    }
    mockDocFn.mockImplementation((docId?: string) => {
      if (!docId) return bookingRef
      if (docId.startsWith('spa-1_')) {
        return { get: () => Promise.resolve(availabilityDoc), id: 'avail-ref' }
      }
      if (docId === 'spa-1') {
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

    const result = (await handler(validInput(), authedContext())) as any
    expect(result.pricing.services).toBe(800)
    expect(result.pricing.addons).toBe(200)
  })

  // -----------------------------------------------------------------------
  // Transaction (atomicity)
  // -----------------------------------------------------------------------

  it('should create booking and hold slot atomically in a transaction', async () => {
    setupHappyPath()
    await handler(validInput(), authedContext())

    expect(mockRunTransaction).toHaveBeenCalledTimes(1)
    expect(mockSet).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('should reject inside transaction if slot became unavailable (TOCTOU)', async () => {
    setupHappyPath()

    mockRunTransaction.mockImplementation(async (cb: Function) => {
      const transaction = {
        get: vi.fn().mockImplementation((arg: unknown) => {
          // Overlap query → no overlap (so we reach the slot check)
          if ((arg as { __overlapQuery?: boolean })?.__overlapQuery) {
            return Promise.resolve({ docs: [] })
          }
          // Availability ref → slot is now unavailable (TOCTOU race won)
          return Promise.resolve({
            exists: true,
            data: () => ({
              slots: [{ start: '10:00', end: '11:00', available: false }],
            }),
          })
        }),
        update: mockUpdate,
        set: mockSet,
      }
      return cb(transaction)
    })

    await expect(handler(validInput(), authedContext())).rejects.toThrow(
      'This time slot is no longer available'
    )
  })

  // -----------------------------------------------------------------------
  // Successful response
  // -----------------------------------------------------------------------

  it('should return correct bookingId and pricing on success', async () => {
    setupHappyPath()
    const result = (await handler(validInput(), authedContext())) as any

    // Wave 1 (Stripe removal, 2026-05-02) — `expiresAt` was eliminated
    // along with draft/hold semantics; pay-at-spa bookings are confirmed
    // immediately, so the response envelope no longer carries an expiry.
    expect(result.success).toBe(true)
    expect(result.bookingId).toBe(GENERATED_BOOKING_ID)
    expect(result.pricing).toBeDefined()
    expect(result.pricing.total).toBeGreaterThan(0)
  })

  it('should set the booking document with correct fields in the transaction', async () => {
    setupHappyPath()
    await handler(validInput(), authedContext())

    const setCall = mockSet.mock.calls[0]
    const bookingData = setCall[1]

    // Wave 1 (Stripe removal, 2026-05-02) — pay-at-spa is the only mode,
    // so bookings are written as `confirmed` (not `draft`) and the
    // statusHistory seed entry mirrors that.
    expect(bookingData.userId).toBe('user-123')
    expect(bookingData.spaId).toBe('spa-1')
    expect(bookingData.therapistId).toBe('therapist-1')
    expect(bookingData.serviceIds).toEqual(['svc-1'])
    expect(bookingData.bookingStatus).toBe('confirmed')
    expect(bookingData.isActive).toBe(true)
    expect(bookingData.createdBy).toBe('customer')
    expect(bookingData.slot.date).toBe('2027-06-15')
    expect(bookingData.slot.start).toBe('10:00')
    expect(bookingData.slot.end).toBe('11:00')
    expect(bookingData.slot.duration).toBe(60)
    expect(bookingData.notes).toBe('Please use lavender oil')
    expect(bookingData.statusHistory).toHaveLength(1)
    expect(bookingData.statusHistory[0].status).toBe('confirmed')
  })

  // -----------------------------------------------------------------------
  // Phase 2 — mandatory customer-location capture
  // -----------------------------------------------------------------------

  function validCustomerLocation() {
    return {
      coords: { lat: 12.97, lng: 77.59, accuracy: 25 },
      source: 'gps' as const,
      addressText: '42 MG Road, Bangalore',
      placeId: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
      additionalDetails: 'Ring doorbell twice',
      capturedAt: '2026-05-01T10:00:00.000Z',
    }
  }

  it('home booking with valid customerLocation succeeds and persists both fields', async () => {
    setupHappyPath()
    const data = {
      ...validInput(),
      bookingLocation: 'home',
      customerLocation: validCustomerLocation(),
    }
    const result = (await handler(data, authedContext())) as any
    expect(result.success).toBe(true)

    const setCall = mockSet.mock.calls[0]
    const bookingData = setCall[1]
    expect(bookingData.bookingLocation).toBe('home')
    expect(bookingData.customerLocation).toEqual(validCustomerLocation())
  })

  it('home booking with no customerLocation throws invalid-argument', async () => {
    const data = { ...validInput(), bookingLocation: 'home' }
    // The contracts-level superRefine fires before any Firestore access, so
    // we don't need setupHappyPath() here.
    await expect(handler(data, authedContext())).rejects.toThrow()
  })

  it('spa booking with no customerLocation succeeds (in-spa default)', async () => {
    setupHappyPath()
    const data = { ...validInput(), bookingLocation: 'spa' }
    const result = (await handler(data, authedContext())) as any
    expect(result.success).toBe(true)

    const setCall = mockSet.mock.calls[0]
    const bookingData = setCall[1]
    expect(bookingData.bookingLocation).toBe('spa')
    // Conditional spread → field never written to Firestore on in-spa
    // bookings (so reads through .optional() schema parse cleanly).
    expect(bookingData.customerLocation).toBeUndefined()
  })

  it('old APK payload (no bookingLocation, no customerLocation) defaults to spa and succeeds', async () => {
    // Forward-compat guarantee: a release-signed APK that predates Phase 2
    // sends a payload with neither field. zod applies .default('spa') and
    // the booking goes through as an in-spa booking.
    setupHappyPath()
    const result = (await handler(validInput(), authedContext())) as any
    expect(result.success).toBe(true)

    const setCall = mockSet.mock.calls[0]
    const bookingData = setCall[1]
    expect(bookingData.bookingLocation).toBe('spa')
    expect(bookingData.customerLocation).toBeUndefined()
  })

  it('rejects home booking with invalid customerLocation.placeId (empty string)', async () => {
    const data = {
      ...validInput(),
      bookingLocation: 'home',
      customerLocation: {
        ...validCustomerLocation(),
        placeId: '', // .min(1) rejects empty string
      },
    }
    await expect(handler(data, authedContext())).rejects.toThrow()
  })

  it('rejects home booking with out-of-range coords', async () => {
    const data = {
      ...validInput(),
      bookingLocation: 'home',
      customerLocation: {
        ...validCustomerLocation(),
        coords: { lat: 999, lng: 77.59, accuracy: 25 },
      },
    }
    await expect(handler(data, authedContext())).rejects.toThrow()
  })
})
