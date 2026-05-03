/**
 * Tests for the markReviewHelpful callable Cloud Function.
 *
 * The handler toggles a vote inside a transaction:
 *   - If caller is NOT in helpfulBy — add via arrayUnion, increment count.
 *   - If caller IS in helpfulBy     — remove via arrayRemove, decrement count.
 *
 * Invariants exercised:
 *   - Auth enforcement.
 *   - Zod shape.
 *   - Review must exist.
 *   - Cannot mark own review as helpful.
 *   - Toggle semantics (idempotent) via helpfulBy membership check.
 *   - Transactional read-then-write.
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
  const collection = mockCollection.mockImplementation(() => ({
    doc: mockDocFn,
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
    increment: (n: number) => ({ _increment: n }),
    arrayUnion: (...args: unknown[]) => ({ _arrayUnion: args }),
    arrayRemove: (...args: unknown[]) => ({ _arrayRemove: args }),
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

import { markReviewHelpful } from '../callable/markReviewHelpful'

const handler = markReviewHelpful as unknown as (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return { reviewId: 'rev-1' }
}

function authedContext(uid = 'voter-1') {
  return { auth: { uid } }
}

interface HappyPathOpts {
  reviewExists?: boolean
  reviewDataIsNull?: boolean
  ownerUid?: string
  helpfulBy?: string[]
  helpfulCount?: number
  txnThrows?: Error
}

function setupHappyPath(opts: HappyPathOpts = {}) {
  const reviewDoc = {
    exists: opts.reviewExists ?? true,
    data: () =>
      opts.reviewDataIsNull
        ? null
        : {
            userId: opts.ownerUid ?? 'author-7',
            helpfulBy: opts.helpfulBy ?? [],
            helpfulCount: opts.helpfulCount ?? 0,
          },
  }

  mockDocFn.mockImplementation(() => ({}))

  mockRunTransaction.mockImplementation(async (cb: Function) => {
    if (opts.txnThrows) throw opts.txnThrows

    const txn = {
      get: vi.fn().mockResolvedValue(reviewDoc),
      update: mockTxnUpdate,
    }
    return cb(txn)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('markReviewHelpful', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('adds vote when caller has not marked review helpful before', async () => {
      setupHappyPath({ helpfulBy: [], helpfulCount: 3 })
      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true)
      expect(result.isHelpful).toBe(true)
      expect(result.helpfulCount).toBe(4)
    })

    it('removes vote when caller has already marked review helpful (toggle off)', async () => {
      setupHappyPath({ helpfulBy: ['voter-1'], helpfulCount: 5 })
      const result = (await handler(validInput(), authedContext('voter-1'))) as any

      expect(result.success).toBe(true)
      expect(result.isHelpful).toBe(false)
      expect(result.helpfulCount).toBe(4)
    })

    it('writes arrayUnion(+increment 1) on first vote', async () => {
      setupHappyPath({ helpfulBy: [] })
      await handler(validInput(), authedContext('voter-1'))

      const updateArgs = mockTxnUpdate.mock.calls[0][1]
      expect(updateArgs.helpfulBy).toEqual({ _arrayUnion: ['voter-1'] })
      expect(updateArgs.helpfulCount).toEqual({ _increment: 1 })
    })

    it('writes arrayRemove(+increment -1) on toggle-off', async () => {
      setupHappyPath({ helpfulBy: ['voter-1'] })
      await handler(validInput(), authedContext('voter-1'))

      const updateArgs = mockTxnUpdate.mock.calls[0][1]
      expect(updateArgs.helpfulBy).toEqual({ _arrayRemove: ['voter-1'] })
      expect(updateArgs.helpfulCount).toEqual({ _increment: -1 })
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

    it('throws not-found when review does not exist', async () => {
      setupHappyPath({ reviewExists: false })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Review not found'
      )
    })

    it('throws not-found when review data payload is null', async () => {
      setupHappyPath({ reviewDataIsNull: true })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        /Review (data )?not found/
      )
    })

    it('throws failed-precondition when caller tries to mark their own review helpful', async () => {
      setupHappyPath({ ownerUid: 'voter-1' })

      await expect(handler(validInput(), authedContext('voter-1'))).rejects.toThrow(
        'You cannot mark your own review as helpful'
      )
    })

    it('rolls back when transaction throws', async () => {
      setupHappyPath({ txnThrows: new Error('Firestore transaction conflict') })

      await expect(handler(validInput(), authedContext())).rejects.toThrow()
      expect(mockTxnUpdate).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Idempotency / de-dup assertions
  // -----------------------------------------------------------------------

  describe('idempotency', () => {
    it('two sequential calls by the same user net to zero change (vote then un-vote)', async () => {
      // First call: not in helpfulBy → vote is added
      setupHappyPath({ helpfulBy: [], helpfulCount: 0 })
      const first = (await handler(validInput(), authedContext('voter-1'))) as any
      expect(first.isHelpful).toBe(true)
      expect(first.helpfulCount).toBe(1)

      // Second call: voter-1 is now in helpfulBy → vote is removed
      setupHappyPath({ helpfulBy: ['voter-1'], helpfulCount: 1 })
      const second = (await handler(validInput(), authedContext('voter-1'))) as any
      expect(second.isHelpful).toBe(false)
      expect(second.helpfulCount).toBe(0)
    })

    it('different users each contribute exactly one vote', async () => {
      setupHappyPath({ helpfulBy: [], helpfulCount: 0 })
      const a = (await handler(validInput(), authedContext('voter-A'))) as any
      expect(a.helpfulCount).toBe(1)

      setupHappyPath({ helpfulBy: ['voter-A'], helpfulCount: 1 })
      const b = (await handler(validInput(), authedContext('voter-B'))) as any
      expect(b.helpfulCount).toBe(2)
    })
  })
})
