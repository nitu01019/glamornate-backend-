/**
 * Tests for the redeemVoucher callable Cloud Function.
 *
 * redeemVoucher mutates two collections atomically inside a Firestore
 * transaction:
 *   1. bookings/{id}        — sets pricing.discount / .tax / .total / voucherId
 *   2. user_vouchers/{id}   — tracks remaining uses per (user, voucher)
 *   3. vouchers/{id}        — increments usedCount
 *
 * KNOWN BUG (documented — not fixed here):
 * Per TRUE_INDEX.md BE-M6, redeemVoucher recomputes pricing from values read
 * OUTSIDE the transaction (booking.pricing.* captured before runTransaction
 * runs). Between the pre-read and the transactional write, another concurrent
 * mutation could shift pricing, and this callable would overwrite that with
 * stale totals. These tests document current behavior; the fix is tracked
 * for Phase 4 BE-M6.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// vi.hoisted() — available inside vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockCollection,
  mockDocFn,
  mockWhere,
  mockRunTransaction,
  mockTxnUpdate,
  mockTxnSet,
} = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDocFn: vi.fn(),
  mockWhere: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockTxnUpdate: vi.fn(),
  mockTxnSet: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const collection = mockCollection.mockImplementation(() => ({
    doc: mockDocFn,
    where: mockWhere,
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

// Pass-through shim for Phase 3 Wave B withRateLimit wrapper. The real helper
// hits Firestore; shimming it keeps this suite's existing mocks focused on the
// voucher-redemption transaction shape.
vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (_opts: unknown, fn: Function) => fn,
}))

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { redeemVoucher } from '../callable/redeemVoucher'

const handler = redeemVoucher as unknown as (
  data: unknown,
  context: { auth?: { uid: string } }
) => Promise<unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput() {
  return {
    code: 'SAVE20',
    bookingId: 'booking-1',
  }
}

function authedContext(uid = 'user-123') {
  return { auth: { uid } }
}

function defaultVoucherData(overrides: Record<string, unknown> = {}) {
  return {
    code: 'SAVE20',
    isActive: true,
    discountType: 'percentage',
    discountValue: 20,
    usageLimit: 100,
    usedCount: 0,
    minOrderAmount: 0,
    maxDiscountAmount: 0,
    validFrom: { toDate: () => new Date(1600000000000) },
    validUntil: { toDate: () => new Date(1800000000000) },
    maxUses: 1,
    ...overrides,
  }
}

function defaultBookingData(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-123',
    bookingStatus: 'draft',
    pricing: {
      services: 2000,
      addons: 0,
      tax: 360,
      platformFee: 400,
      total: 2760,
    },
    ...overrides,
  }
}

interface HappyPathOpts {
  voucherOverrides?: Record<string, unknown>
  bookingOverrides?: Record<string, unknown>
  userVoucherExists?: boolean
  userVoucherData?: Record<string, unknown>
  txnVoucherOverrides?: Record<string, unknown>
  txnThrows?: Error
}

function setupHappyPath(opts: HappyPathOpts = {}) {
  const voucherRef = { id: 'vch-1', path: 'vouchers/vch-1' }
  const voucherDoc = {
    id: 'vch-1',
    ref: voucherRef,
    exists: true,
    data: () => defaultVoucherData(opts.voucherOverrides),
  }

  const voucherSnapshot = {
    empty: false,
    docs: [voucherDoc],
  }

  // vouchers().where('code', '==').where('isActive', '==').get()
  mockWhere.mockImplementation(() => ({
    where: () => ({
      get: () => Promise.resolve(voucherSnapshot),
    }),
  }))

  const userVoucherDoc = opts.userVoucherExists
    ? {
        exists: true,
        data: () => opts.userVoucherData ?? { remainingUses: 1, maxUses: 1 },
      }
    : { exists: false, data: () => null }

  const bookingRef = { id: 'booking-1', path: 'bookings/booking-1' }
  const bookingDoc = {
    exists: true,
    ref: bookingRef,
    data: () => defaultBookingData(opts.bookingOverrides),
  }

  mockDocFn.mockImplementation((docId: string) => {
    if (docId === 'user-123_vch-1') {
      return {
        id: 'user-123_vch-1',
        get: () => Promise.resolve(userVoucherDoc),
      }
    }
    if (docId === 'booking-1') {
      return {
        id: 'booking-1',
        get: () => Promise.resolve(bookingDoc),
      }
    }
    return {
      id: docId,
      get: () => Promise.resolve({ exists: false, data: () => null }),
    }
  })

  // runTransaction(fn): exposes txn.get / update / set. txn.get is
  // ref-aware — voucherRef returns voucher state (supports txnVoucherOverrides
  // for simulating a usage-limit conflict), bookingRef returns booking state.
  // Ownership re-verification at redeemVoucher.ts:125-134 requires that the
  // transactional bookingDoc.data().userId matches the caller's uid.
  mockRunTransaction.mockImplementation(async (cb: Function) => {
    if (opts.txnThrows) throw opts.txnThrows

    const txnVoucherSnap = {
      exists: true,
      ref: voucherRef,
      data: () =>
        defaultVoucherData({ ...opts.voucherOverrides, ...opts.txnVoucherOverrides }),
    }
    const txnBookingSnap = {
      exists: true,
      ref: bookingRef,
      data: () => defaultBookingData(opts.bookingOverrides),
    }

    const txn = {
      get: vi.fn().mockImplementation((ref: { id?: string; path?: string } | undefined) => {
        if (ref?.id === 'booking-1' || ref?.path === 'bookings/booking-1') {
          return Promise.resolve(txnBookingSnap)
        }
        // Default: voucher (includes the explicit voucherRef path)
        return Promise.resolve(txnVoucherSnap)
      }),
      update: mockTxnUpdate,
      set: mockTxnSet,
    }
    return cb(txn)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('redeemVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TAX_RATE_PERCENT = '18'
    process.env.PLATFORM_FEE_PERCENT = '20'
  })

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('applies percentage discount and returns new totals', async () => {
      setupHappyPath()

      const result = (await handler(validInput(), authedContext())) as any

      expect(result.success).toBe(true)
      // services = 2000, 20% percentage → discount = 400
      expect(result.discountAmount).toBe(400)
      // discountedServices = 1600, tax = 288, fee = 320, total = 2208
      expect(result.newTotal).toBe(2208)
      expect(result.voucherName).toBe('SAVE20')
    })

    it('applies flat discount when discountType=flat', async () => {
      setupHappyPath({
        voucherOverrides: { discountType: 'flat', discountValue: 500 },
      })

      const result = (await handler(validInput(), authedContext())) as any
      expect(result.discountAmount).toBe(500)
    })

    it('caps discount at maxDiscountAmount', async () => {
      setupHappyPath({
        voucherOverrides: {
          discountType: 'percentage',
          discountValue: 50,
          maxDiscountAmount: 300,
        },
      })

      const result = (await handler(validInput(), authedContext())) as any
      // 50% of 2000 = 1000, but capped at 300
      expect(result.discountAmount).toBe(300)
    })

    it('updates booking + user_vouchers + voucher inside a single transaction', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      expect(mockRunTransaction).toHaveBeenCalledTimes(1)
      // booking.update + voucher.update (increment); user_voucher.set (new record)
      expect(mockTxnUpdate).toHaveBeenCalledTimes(2)
      expect(mockTxnSet).toHaveBeenCalledTimes(1)
    })

    it('writes the correct discount fields to the booking', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      // First update call is the booking document
      const bookingUpdateArgs = mockTxnUpdate.mock.calls[0][1]
      expect(bookingUpdateArgs['pricing.discount']).toBe(400)
      expect(bookingUpdateArgs['pricing.total']).toBe(2208)
      expect(bookingUpdateArgs.voucherId).toBe('vch-1')
    })

    it('increments voucher.usedCount via FieldValue.increment(1)', async () => {
      setupHappyPath()
      await handler(validInput(), authedContext())

      // Second update call is the voucher document
      const voucherUpdateArgs = mockTxnUpdate.mock.calls[1][1]
      expect(voucherUpdateArgs.usedCount).toEqual({ _increment: 1 })
    })

    it('updates existing user_voucher record instead of creating', async () => {
      setupHappyPath({
        userVoucherExists: true,
        userVoucherData: { remainingUses: 3, maxUses: 5 },
      })
      await handler(validInput(), authedContext())

      // With an existing user_voucher, we expect update instead of set
      // booking.update + userVoucher.update + voucher.update = 3 updates
      expect(mockTxnUpdate).toHaveBeenCalledTimes(3)
      expect(mockTxnSet).not.toHaveBeenCalled()
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

    it('throws on zod validation when code is too short', async () => {
      await expect(
        handler({ code: 'AB', bookingId: 'booking-1' }, authedContext())
      ).rejects.toThrow()
    })

    it('throws on zod validation when bookingId is missing', async () => {
      await expect(handler({ code: 'SAVE20' }, authedContext())).rejects.toThrow()
    })

    it('throws not-found when voucher code does not exist', async () => {
      mockWhere.mockImplementation(() => ({
        where: () => ({
          get: () => Promise.resolve({ empty: true, docs: [] }),
        }),
      }))

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Invalid or expired voucher code'
      )
    })

    it('throws failed-precondition when voucher not yet active (validFrom in future)', async () => {
      setupHappyPath({
        voucherOverrides: {
          validFrom: { toDate: () => new Date(Date.now() + 86_400_000) },
        },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'This voucher is not yet active'
      )
    })

    it('throws failed-precondition when voucher has expired', async () => {
      setupHappyPath({
        voucherOverrides: {
          validUntil: { toDate: () => new Date(Date.now() - 86_400_000) },
        },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'This voucher has expired'
      )
    })

    it('throws failed-precondition when user has already redeemed (remainingUses=0)', async () => {
      setupHappyPath({
        userVoucherExists: true,
        userVoucherData: { remainingUses: 0, maxUses: 1 },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'You have already used this voucher'
      )
    })

    it('throws not-found when booking does not exist', async () => {
      setupHappyPath()
      // Override booking doc to missing
      mockDocFn.mockImplementation((docId: string) => {
        if (docId === 'user-123_vch-1') {
          return { get: () => Promise.resolve({ exists: false, data: () => null }) }
        }
        if (docId === 'booking-1') {
          return { get: () => Promise.resolve({ exists: false, data: () => null }) }
        }
        return { get: () => Promise.resolve({ exists: false, data: () => null }) }
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Booking not found'
      )
    })

    it('throws permission-denied when booking is not owned by caller', async () => {
      setupHappyPath({
        bookingOverrides: { userId: 'different-user' },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Not authorized for this booking'
      )
    })

    it('throws failed-precondition when booking is not in draft status', async () => {
      setupHappyPath({
        bookingOverrides: { bookingStatus: 'confirmed' },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'Voucher can only be applied to draft bookings'
      )
    })

    it('throws failed-precondition when booking total < minOrderAmount', async () => {
      setupHappyPath({
        voucherOverrides: { minOrderAmount: 5000 },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        /Minimum order amount/
      )
    })

    it('throws failed-precondition when voucher hits usage limit inside transaction', async () => {
      setupHappyPath({
        txnVoucherOverrides: { usageLimit: 10, usedCount: 10 },
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow(
        'This voucher has reached its usage limit'
      )
    })

    it('rolls back when the transaction itself throws', async () => {
      setupHappyPath({
        txnThrows: new Error('Firestore transaction conflict'),
      })

      await expect(handler(validInput(), authedContext())).rejects.toThrow()
      // No partial writes: the txn throw prevents any transactional callback
      expect(mockTxnUpdate).not.toHaveBeenCalled()
      expect(mockTxnSet).not.toHaveBeenCalled()
    })
  })
})
