/**
 * Tests for the submitReview callable Cloud Function.
 *
 * Invariants exercised:
 *   - Auth enforcement.
 *   - Zod shape (rating 1-5, title length, comment length).
 *   - Ownership check (booking.userId === caller).
 *   - Booking must be in 'completed' state.
 *   - One-review-per-booking invariant (booking.reviewId + reviews query).
 *   - Side-effects: new reviews doc created, booking.reviewId back-reference set.
 *
 * NOTE ON PHASE 3 WAVE B: The sibling agent wrapped submitReview with
 * `withRateLimit`. That wrapper is mocked as a pass-through below so the
 * rate limiter never short-circuits these tests.
 *
 * DOCUMENTED BUGS (per C14b task brief, NOT fixed here):
 *
 *   1. submitReview.photos accepts arbitrary strings but the handler does
 *      not verify the URLs actually resolve to uploaded assets — a client
 *      can reference photos that were never uploaded. Tracked for future
 *      hardening.
 *
 *   2. [BLOCKER — affects this test file] `src/callable/submitReview.ts`
 *      in its post-Wave-B shape with `withRateLimit(...)` cannot be parsed
 *      by vite's default oxc transformer. tsc itself compiles the file
 *      cleanly (see lib/callable/submitReview.js) and the structurally
 *      identical createPaymentIntent.ts parses fine, so this is an oxc
 *      parser bug specific to the current whitespace / line-break shape
 *      of submitReview.ts (the inner arrow function body is indented at
 *      2 spaces instead of the 6 used by createPaymentIntent).
 *
 *      Until the source is reformatted or oxc is updated, importing
 *      `../callable/submitReview` blows up with:
 *        [PARSE_ERROR] Expected `,` or `)` but found `;`
 *            at src/callable/submitReview.ts:118:3
 *
 *      The tests below are therefore wrapped in describe.skip() with a
 *      clear TODO so the suite stays green and the parse failure doesn't
 *      leak into CI. Once the source indentation is normalised, flip
 *      `describe.skip` → `describe` to activate the suite.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted()
// ---------------------------------------------------------------------------

const {
  mockCollection,
  mockDocFn,
  mockWhere,
  mockAdd,
  mockDocUpdate,
  mockBookingRefUpdate,
} = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDocFn: vi.fn(),
  mockWhere: vi.fn(),
  mockAdd: vi.fn(),
  mockDocUpdate: vi.fn(),
  mockBookingRefUpdate: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = mockCollection.mockImplementation(() => ({
    doc: mockDocFn,
    where: mockWhere,
    add: mockAdd,
  }))

  const firestoreInstance = { collection }

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

vi.mock('../utils/validator', () => ({
  // Real sanitizeInput escapes HTML — for tests we pass through unchanged
  sanitizeInput: (s: string) => s,
}))

// Pass-through shim for Phase 3 Wave B withRateLimit wrapper (no-op if absent)
vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (_opts: unknown, fn: Function) => fn,
}))

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------
//
// NOTE: Intentionally NOT importing `../callable/submitReview` at module
// load because the post-Wave-B source file currently trips an oxc parse
// error (see header comment). The handler is resolved lazily inside the
// (currently skipped) suite so that reactivation is a single describe.skip
// → describe flip once the source is reformatted.

let handler: (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>
async function loadHandler() {
  const mod = await import('../callable/submitReview')
  handler = mod.submitReview as unknown as typeof handler
}
void loadHandler // suppress unused warning in skip mode

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    bookingId: 'booking-1',
    rating: 5,
    title: 'Amazing experience',
    comment: 'The therapist was wonderful and the ambiance was relaxing.',
    aspects: { ambiance: 5, service: 5, therapist: 5, hygiene: 4 },
    photos: ['https://cdn.example.com/photo1.jpg'],
    ...overrides,
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
    bookingStatus: 'completed',
    reviewId: null,
    ...overrides,
  }
}

interface HappyPathOpts {
  bookingOverrides?: Record<string, unknown>
  existingReviewEmpty?: boolean
}

function setupHappyPath(opts: HappyPathOpts = {}) {
  const bookingRef = { id: 'booking-1', update: mockBookingRefUpdate }
  const bookingDoc = {
    exists: true,
    ref: bookingRef,
    data: () => defaultBooking(opts.bookingOverrides),
  }

  mockDocFn.mockImplementation(() => ({
    get: () => Promise.resolve(bookingDoc),
    update: mockDocUpdate,
  }))

  // reviews().where(...).where(...).get()
  mockWhere.mockImplementation(() => ({
    where: () => ({
      get: () =>
        Promise.resolve({
          empty: opts.existingReviewEmpty ?? true,
          docs: [],
        }),
    }),
  }))

  mockAdd.mockResolvedValue({ id: 'rev-new-1' })
  mockBookingRefUpdate.mockResolvedValue(undefined)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Re-activated by Phase 3 Wave C: the oxc parse blocker in submitReview.ts
// was fixed upstream. We now load the handler eagerly in beforeAll.
describe('submitReview', () => {
  beforeAll(loadHandler)
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('creates a review for a completed booking owned by caller', async () => {
      setupHappyPath()
      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true)
      expect(result.reviewId).toBe('rev-new-1')
      expect(mockAdd).toHaveBeenCalledTimes(1)
    })

    it('stores the rating, title, and comment on the review document', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      const addArgs = mockAdd.mock.calls[0][0]
      expect(addArgs.rating).toBe(5)
      expect(addArgs.title).toBe('Amazing experience')
      expect(addArgs.comment).toMatch(/wonderful/)
      expect(addArgs.userId).toBe('user-123')
      expect(addArgs.bookingId).toBe('booking-1')
    })

    it('defaults aspects when not provided by client', async () => {
      setupHappyPath()
      const { aspects, ...withoutAspects } = validInput()
      void aspects
      await handler(withoutAspects, authedContext())

      const addArgs = mockAdd.mock.calls[0][0]
      expect(addArgs.aspects).toEqual({ ambiance: 0, service: 0, therapist: 0, hygiene: 0 })
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

    it('throws unauthenticated when auth is entirely absent', async () => {
      await expect(handler(validInput(), {} as any)).rejects.toThrow(
        'Authentication required'
      )
    })

    it('throws on zod validation when rating is out of 1-5 range', async () => {
      await expect(
        handler(validInput({ rating: 6 }), authedContext())
      ).rejects.toThrow()
    })

    it('throws on zod validation when rating is zero', async () => {
      await expect(
        handler(validInput({ rating: 0 }), authedContext())
      ).rejects.toThrow()
    })

    it('throws on zod validation when comment is too short (<10 chars)', async () => {
      await expect(
        handler(validInput({ comment: 'Nice' }), authedContext())
      ).rejects.toThrow()
    })

    it('throws on zod validation when title is empty', async () => {
      await expect(
        handler(validInput({ title: '' }), authedContext())
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

    it('throws permission-denied when booking.userId != caller', async () => {
      setupHappyPath({ bookingOverrides: { userId: 'different-user' } })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Not authorized to review this booking'
      )
    })

    it('throws failed-precondition when booking is not completed', async () => {
      setupHappyPath({ bookingOverrides: { bookingStatus: 'confirmed' } })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Can only review completed bookings'
      )
    })

    it('throws already-exists when booking already has a reviewId', async () => {
      setupHappyPath({ bookingOverrides: { reviewId: 'rev-old-1' } })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Review already submitted'
      )
    })

    it('throws already-exists when prior review exists in reviews collection', async () => {
      setupHappyPath({ existingReviewEmpty: false })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Review already exists for this booking'
      )
    })
  })

  // -----------------------------------------------------------------------
  // One-review-per-booking invariant + side-effects
  // -----------------------------------------------------------------------

  describe('invariant + side-effects', () => {
    it('updates booking.reviewId back-reference on success', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      expect(mockBookingRefUpdate).toHaveBeenCalledTimes(1)
      const updateArgs = mockBookingRefUpdate.mock.calls[0][0]
      expect(updateArgs.reviewId).toBe('rev-new-1')
    })

    it('second submission on same booking is rejected after first succeeds', async () => {
      // First call: clean slate, succeeds
      setupHappyPath()
      const first = (await handler(validInput(), authedContext())) as any
      expect(first.success).toBe(true)

      // Second call: booking now has reviewId set
      setupHappyPath({ bookingOverrides: { reviewId: 'rev-new-1' } })
      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Review already submitted'
      )
    })
  })
})
