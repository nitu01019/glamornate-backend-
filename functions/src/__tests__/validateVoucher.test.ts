/**
 * Tests for the validateVoucher callable Cloud Function.
 *
 * The callable is a thin wrapper around the `validateVoucher` utility in
 * utils/vouchers.ts. We mock the utility directly to keep this test focused
 * on the callable's wire-level contract:
 *   - auth enforcement
 *   - zod validation of input shape
 *   - pass-through of utility result into the response envelope
 *
 * The utility itself has dedicated tests elsewhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted() — available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { mockValidateVoucherUtil } = vi.hoisted(() => ({
  mockValidateVoucherUtil: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = vi.fn().mockReturnValue({
    doc: vi.fn(),
    where: vi.fn(),
  })
  const firestoreInstance = { collection }
  const firestoreFn = () => firestoreInstance
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 1700000000, toDate: () => new Date(1700000000000) }),
  }
  firestoreFn.FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
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

vi.mock('../utils/vouchers', () => ({
  validateVoucher: (...args: unknown[]) => mockValidateVoucherUtil(...args),
}))

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

import { validateVoucher } from '../callable/validateVoucher'

const handler = validateVoucher as unknown as (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return {
    code: 'SAVE20',
    bookingData: {
      spaId: 'spa-1',
      serviceIds: ['svc-1'],
      totalAmount: 2000,
    },
  }
}

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // Happy path — utility returns valid voucher
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('returns success + valid voucher when utility approves', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: true,
        voucher: {
          id: 'vch-1',
          code: 'SAVE20',
          discountType: 'percentage',
          discountValue: 20,
        },
        discountAmount: 400,
      })

      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true)
      expect(result.valid).toBe(true)
      expect(result.discountAmount).toBe(400)
      expect(result.voucher).toBeDefined()
      expect(result.voucher.code).toBe('SAVE20')
    })

    it('passes the uppercase-agnostic code through to the utility', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: true,
        voucher: { id: 'vch-2', code: 'FLAT100' },
        discountAmount: 100,
      })

      const data = { ...validInput(), code: 'flat100' }
      await handler(data, authedContext())

      expect(mockValidateVoucherUtil).toHaveBeenCalledTimes(1)
      const [code, userId, bookingData] = mockValidateVoucherUtil.mock.calls[0]
      expect(code).toBe('flat100')
      expect(userId).toBe('user-123')
      expect(bookingData).toEqual(validInput().bookingData)
    })

    it('forwards bookingData fields unchanged to the utility', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: true,
        voucher: { id: 'vch-3' },
        discountAmount: 150,
      })

      await handler(validInput(), authedContext())

      const bookingDataArg = mockValidateVoucherUtil.mock.calls[0][2]
      expect(bookingDataArg.spaId).toBe('spa-1')
      expect(bookingDataArg.serviceIds).toEqual(['svc-1'])
      expect(bookingDataArg.totalAmount).toBe(2000)
    })
  })

  // -----------------------------------------------------------------------
  // Pass-through of utility's invalid cases
  // -----------------------------------------------------------------------

  describe('utility rejects', () => {
    it('returns valid=false + error when voucher code is unknown', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: false,
        discountAmount: 0,
        error: 'Invalid voucher code',
      })

      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true) // callable succeeded
      expect(result.valid).toBe(false)
      expect(result.discountAmount).toBe(0)
      expect(result.error).toBe('Invalid voucher code')
    })

    it('returns valid=false when voucher has expired', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: false,
        discountAmount: 0,
        error: 'This voucher has expired',
      })

      const result = (await handler(validInput(), authedContext())) as any
      expect(result.valid).toBe(false)
      expect(result.error).toBe('This voucher has expired')
    })

    it('returns valid=false when user has already used this voucher', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: false,
        discountAmount: 0,
        error: 'You have already used this voucher',
      })

      const result = (await handler(validInput(), authedContext())) as any
      expect(result.valid).toBe(false)
      expect(result.error).toBe('You have already used this voucher')
    })

    it('returns valid=false when spa-scoped voucher does not match cart spa', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: false,
        discountAmount: 0,
        error: 'This voucher is not applicable to your selection',
      })

      const result = (await handler(validInput(), authedContext())) as any
      expect(result.valid).toBe(false)
      expect(result.error).toBe('This voucher is not applicable to your selection')
    })

    it('returns valid=false when cart total is below minOrderAmount', async () => {
      mockValidateVoucherUtil.mockResolvedValueOnce({
        valid: false,
        discountAmount: 0,
        error: 'Minimum order amount of ₹5000 required',
      })

      const data = { ...validInput(), bookingData: { ...validInput().bookingData, totalAmount: 1000 } }
      const result = (await handler(data, authedContext())) as any

      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/Minimum order amount/)
    })
  })

  // -----------------------------------------------------------------------
  // Failure modes — callable guards before utility
  // -----------------------------------------------------------------------

  describe('failure modes', () => {
    it('throws unauthenticated when context.auth is missing', async () => {
      await expect(handler(validInput(), { auth: undefined })).rejects.toThrow(
        'Authentication required'
      )
      expect(mockValidateVoucherUtil).not.toHaveBeenCalled()
    })

    it('throws unauthenticated when auth object is missing entirely', async () => {
      await expect(handler(validInput(), {} as any)).rejects.toThrow(
        'Authentication required'
      )
      expect(mockValidateVoucherUtil).not.toHaveBeenCalled()
    })

    it('throws on zod validation error when code is missing', async () => {
      const { code: _omit, ...rest } = validInput()
      await expect(handler(rest, authedContext())).rejects.toThrow()
      expect(mockValidateVoucherUtil).not.toHaveBeenCalled()
    })

    it('throws on zod validation error when bookingData.spaId is missing', async () => {
      const data = {
        code: 'SAVE20',
        bookingData: { serviceIds: ['svc-1'], totalAmount: 2000 },
      }
      await expect(handler(data, authedContext())).rejects.toThrow()
      expect(mockValidateVoucherUtil).not.toHaveBeenCalled()
    })

    it('throws on zod validation error when serviceIds is not an array', async () => {
      const data = {
        code: 'SAVE20',
        bookingData: { spaId: 'spa-1', serviceIds: 'svc-1', totalAmount: 2000 },
      }
      await expect(handler(data, authedContext())).rejects.toThrow()
      expect(mockValidateVoucherUtil).not.toHaveBeenCalled()
    })

    it('throws on zod validation error when totalAmount is not a number', async () => {
      const data = {
        code: 'SAVE20',
        bookingData: { spaId: 'spa-1', serviceIds: ['svc-1'], totalAmount: '2000' },
      }
      await expect(handler(data, authedContext())).rejects.toThrow()
      expect(mockValidateVoucherUtil).not.toHaveBeenCalled()
    })

    it('propagates errors thrown by the utility (e.g. Firestore unavailable)', async () => {
      mockValidateVoucherUtil.mockRejectedValueOnce(new Error('Firestore down'))

      await expect(handler(validInput(), authedContext())).rejects.toThrow()
    })
  })
})
