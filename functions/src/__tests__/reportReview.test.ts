/**
 * Tests for the reportReview callable Cloud Function.
 *
 * Invariants exercised:
 *   - Auth enforcement.
 *   - Zod shape.
 *   - review must exist.
 *   - reportedBy de-dup: a user cannot report the same review twice.
 *   - Side-effects: reportedBy gains caller UID (arrayUnion),
 *     reportedCount increments by 1, updatedAt stamp.
 *
 * DOCUMENTED OBSERVATION (per C14b brief, NOT fixed here):
 * The current handler does NOT require a `reason` string on the report
 * payload — the Zod schema only mandates `reviewId`. The task brief calls
 * for reason to be required; this gap is documented for a follow-up PR.
 * Additionally, there is NO explicit "cannot report your own review" guard
 * — that invariant is enforced client-side only today.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted()
// ---------------------------------------------------------------------------

const {
  mockCollection,
  mockDocFn,
  mockDocUpdate,
} = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDocFn: vi.fn(),
  mockDocUpdate: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = mockCollection.mockImplementation(() => ({
    doc: mockDocFn,
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

import { reportReview } from '../callable/reportReview'

const handler = reportReview as unknown as (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return { reviewId: 'rev-1' }
}

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

interface HappyPathOpts {
  reviewExists?: boolean
  reportedBy?: string[]
  updateThrows?: Error
}

function setupHappyPath(opts: HappyPathOpts = {}) {
  const reviewDoc = {
    exists: opts.reviewExists ?? true,
    data: () => ({
      reportedBy: opts.reportedBy ?? [],
    }),
  }

  mockDocFn.mockImplementation(() => ({
    get: () => Promise.resolve(reviewDoc),
    update: opts.updateThrows
      ? () => Promise.reject(opts.updateThrows)
      : mockDocUpdate,
  }))

  mockDocUpdate.mockResolvedValue(undefined)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reportReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('records a report for a review the caller has not reported before', async () => {
      setupHappyPath()
      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true)
      expect(result.reviewId).toBe('rev-1')
    })

    it('adds caller UID to reportedBy via arrayUnion and increments count', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext('user-123'))

      expect(mockDocUpdate).toHaveBeenCalledTimes(1)
      const updateArgs = mockDocUpdate.mock.calls[0][0]
      expect(updateArgs.reportedBy).toEqual({ _arrayUnion: ['user-123'] })
      expect(updateArgs.reportedCount).toEqual({ _increment: 1 })
    })

    it('stamps updatedAt on the review document', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      const updateArgs = mockDocUpdate.mock.calls[0][0]
      expect(updateArgs.updatedAt).toBeDefined()
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

    it('throws on zod validation when reviewId is missing', async () => {
      await expect(handler({}, authedContext())).rejects.toThrow()
    })

    it('throws on zod validation when reviewId is a number', async () => {
      await expect(handler({ reviewId: 42 }, authedContext())).rejects.toThrow()
    })

    it('throws not-found when review does not exist', async () => {
      setupHappyPath({ reviewExists: false })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Review not found'
      )
    })

    it('throws already-exists when caller has already reported this review', async () => {
      setupHappyPath({ reportedBy: ['user-123', 'other-user'] })

      await expect(handler(validInput(), authedContext('user-123'))).rejects.toThrow(
        'You have already reported this review'
      )
    })
  })

  // -----------------------------------------------------------------------
  // Idempotency / de-dup assertions
  // -----------------------------------------------------------------------

  describe('idempotency', () => {
    it('is idempotent: second report attempt by same user is rejected', async () => {
      // First report: succeeds
      setupHappyPath({ reportedBy: [] })
      const first = (await handler(validInput(), authedContext())) as any
      expect(first.success).toBe(true)

      // Second report: reportedBy now contains caller UID
      setupHappyPath({ reportedBy: ['user-123'] })
      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'You have already reported this review'
      )
    })

    it('allows two different users to independently report the same review', async () => {
      // User A reports
      setupHappyPath({ reportedBy: [] })
      const a = (await handler(validInput(), authedContext('user-A'))) as any
      expect(a.success).toBe(true)

      // User B reports (after A's write landed)
      setupHappyPath({ reportedBy: ['user-A'] })
      const b = (await handler(validInput(), authedContext('user-B'))) as any
      expect(b.success).toBe(true)
    })
  })
})
