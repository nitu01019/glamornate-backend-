/**
 * Tests for the approveSpaRegistration callable Cloud Function.
 *
 * Invariants exercised:
 *   - Auth enforcement.
 *   - Zod shape.
 *   - Admin role gate (users/{caller}.role === 'admin').
 *   - registrationRequest must exist and be in 'pending_review'.
 *   - spa doc must exist and be in 'pending' status.
 *   - Atomic batch: users/{applicant} role flip, spas/{spaId} activation,
 *     registrationRequests/{spaId} approved marker.
 *   - Non-critical audit_log write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted()
// ---------------------------------------------------------------------------

const {
  mockCollection,
  mockDocFn,
  mockAdd,
  mockBatch,
  mockBatchUpdate,
  mockBatchCommit,
} = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDocFn: vi.fn(),
  mockAdd: vi.fn(),
  mockBatch: vi.fn(),
  mockBatchUpdate: vi.fn(),
  mockBatchCommit: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = mockCollection.mockImplementation(() => ({
    doc: mockDocFn,
    add: mockAdd,
  }))

  const firestoreInstance = {
    collection,
    batch: mockBatch,
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

import { approveSpaRegistration } from '../callable/approveSpaRegistration'

const handler = approveSpaRegistration as unknown as (
  data: unknown,
  context: {
    auth?: { uid: string }
    rawRequest?: { ip?: string; headers: Record<string, string | undefined> }
  }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return { spaId: 'spa-1' }
}

function adminContext(uid = 'admin-007') {
  return {
    auth: { uid },
    rawRequest: {
      ip: '10.0.0.1',
      headers: { 'user-agent': 'vitest' },
    },
  }
}

interface HappyPathOpts {
  adminRole?: string
  requestStatus?: string
  requestExists?: boolean
  spaStatus?: string
  spaExists?: boolean
  batchCommitThrows?: Error
}

function setupHappyPath(opts: HappyPathOpts = {}) {
  const adminUserDoc = {
    exists: true,
    data: () => ({
      role: opts.adminRole ?? 'admin',
    }),
  }

  const requestRef = { id: 'spa-1', path: 'registrationRequests/spa-1' }
  const requestDoc = {
    exists: opts.requestExists ?? true,
    ref: requestRef,
    data: () => ({
      userId: 'applicant-42',
      status: opts.requestStatus ?? 'pending_review',
    }),
  }

  const spaRef = { id: 'spa-1', path: 'spas/spa-1' }
  const spaDoc = {
    exists: opts.spaExists ?? true,
    ref: spaRef,
    data: () => ({
      status: opts.spaStatus ?? 'pending',
      commission: { platformPercentage: 20 },
    }),
  }

  mockDocFn.mockImplementation((docId: string) => {
    if (docId === 'admin-007') {
      return { get: () => Promise.resolve(adminUserDoc) }
    }
    if (docId === 'applicant-42') {
      return { get: () => Promise.resolve({ exists: true, data: () => ({}) }) }
    }
    // The spaId is 'spa-1' — both registrationRequests and spas doc share the id.
    // Distinguish via call order: first request lookup, then spa.
    if (docId === 'spa-1') {
      // Return a minimal ref object — the handler uses requestRef/spaRef directly.
      // We key get() differently by counting calls via a shared counter.
      return {
        get: () => {
          if (!sp._call) sp._call = 0
          sp._call += 1
          return sp._call === 1
            ? Promise.resolve(requestDoc)
            : Promise.resolve(spaDoc)
        },
      }
    }
    return { get: () => Promise.resolve({ exists: false, data: () => null }) }
  })

  mockBatch.mockImplementation(() => ({
    update: mockBatchUpdate,
    commit: mockBatchCommit,
  }))

  if (opts.batchCommitThrows) {
    mockBatchCommit.mockRejectedValue(opts.batchCommitThrows)
  } else {
    mockBatchCommit.mockResolvedValue(undefined)
  }

  mockAdd.mockResolvedValue({ id: 'audit-1' })
}

// Type alias + aliased reference so the mutable `_call` counter is
// typed correctly at every read/write site (instead of reaching for
// `as any` repeatedly). Runtime behavior is unchanged — the counter
// is still hung off the `setupHappyPath` function object.
type SetupHappyPathWithCounter = typeof setupHappyPath & { _call: number }
const sp = setupHappyPath as SetupHappyPathWithCounter
sp._call = 0

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approveSpaRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sp._call = 0
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('approves a pending spa and returns success envelope', async () => {
      setupHappyPath()
      const result = (await handler(validInput(), adminContext())) as any

      expect(result.success).toBe(true)
      expect(result.spaId).toBe('spa-1')
      expect(mockBatchCommit).toHaveBeenCalledTimes(1)
    })

    it('elevates applicant role to spa_owner via batch update', async () => {
      setupHappyPath()
      await handler(validInput(), adminContext())

      // First batch.update is against users/{applicant}
      const userUpdateArgs = mockBatchUpdate.mock.calls[0][1]
      expect(userUpdateArgs.role).toBe('spa_owner')
      expect(userUpdateArgs.spaData.spaId).toBe('spa-1')
      expect(userUpdateArgs.spaData.commissionRate).toBe(20)
    })

    it('activates the spa by setting status=active and isActive=true', async () => {
      setupHappyPath()
      await handler(validInput(), adminContext())

      // Second batch.update is against spas/{spaId}
      const spaUpdateArgs = mockBatchUpdate.mock.calls[1][1]
      expect(spaUpdateArgs.status).toBe('active')
      expect(spaUpdateArgs.isActive).toBe(true)
    })

    it('marks registrationRequests/{spaId} as approved with approvedBy', async () => {
      setupHappyPath()
      await handler(validInput(), adminContext())

      // Third batch.update is against registrationRequests/{spaId}
      const reqUpdateArgs = mockBatchUpdate.mock.calls[2][1]
      expect(reqUpdateArgs.status).toBe('approved')
      expect(reqUpdateArgs.approvedBy).toBe('admin-007')
    })
  })

  // -----------------------------------------------------------------------
  // Failure modes
  // -----------------------------------------------------------------------

  describe('failure modes', () => {
    it('throws unauthenticated when context.auth is missing', async () => {
      await expect(handler(validInput(), { auth: undefined, rawRequest: { headers: {} } })).rejects.toThrow(
        'Authentication required'
      )
    })

    it('throws on zod validation when spaId is empty string', async () => {
      await expect(handler({ spaId: '' }, adminContext())).rejects.toThrow()
    })

    it('throws permission-denied when caller is not an admin', async () => {
      setupHappyPath({ adminRole: 'customer' })

      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        'Only admins can approve spa registrations'
      )
    })

    it('throws permission-denied when caller role is spa_owner', async () => {
      setupHappyPath({ adminRole: 'spa_owner' })

      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        'Only admins can approve spa registrations'
      )
    })

    it('throws not-found when registrationRequest does not exist', async () => {
      setupHappyPath({ requestExists: false })

      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        'Registration request not found'
      )
    })

    it('throws failed-precondition when request is not in pending_review', async () => {
      setupHappyPath({ requestStatus: 'approved' })

      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        /already in status 'approved'/
      )
    })

    it('throws not-found when spa document does not exist', async () => {
      setupHappyPath({ spaExists: false })

      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        'Spa document not found'
      )
    })

    it('throws failed-precondition when spa is already active', async () => {
      setupHappyPath({ spaStatus: 'active' })

      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        /already in status 'active'/
      )
    })
  })

  // -----------------------------------------------------------------------
  // Side-effects / idempotency
  // -----------------------------------------------------------------------

  describe('side-effects', () => {
    it('writes an audit_log entry after successful approval', async () => {
      setupHappyPath()
      await handler(validInput(), adminContext())

      // audit_logs.add is called once, after batch.commit
      expect(mockAdd).toHaveBeenCalledTimes(1)
      const auditArgs = mockAdd.mock.calls[0][0]
      expect(auditArgs.action).toBe('spa_registration_approved')
      expect(auditArgs.entity.id).toBe('spa-1')
      expect(auditArgs.userId).toBe('admin-007')
    })

    it('is idempotent: second approval attempt rejects with already-approved precondition', async () => {
      // First call succeeds
      setupHappyPath()
      await handler(validInput(), adminContext())

      // Second call: request is now 'approved', spa is 'active'
      setupHappyPath({ requestStatus: 'approved', spaStatus: 'active' })
      await expect(handler(validInput(), adminContext())).rejects.toThrow(
        /already in status/
      )
    })
  })
})
