/**
 * Tests for the Firestore-backed rate-limiting wrapper.
 *
 * Focus:
 *   - B3 expiresAt field is written on every `_rateLimits` set/update so
 *     the gcloud TTL policy can garbage-collect rolled-out buckets.
 *   - Anchor rule: expiresAt = firstAt + opts.windowMs * 2 (NOT now + ...)
 *     so a client hammering the bucket can't keep pushing TTL forward.
 *   - Rate-limit exceeded throws HttpsError('resource-exhausted').
 *   - Firestore transaction errors fail-open (log + allow through).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockCollection,
  mockDoc,
  mockRunTransaction,
  mockTxnGet,
  mockTxnSet,
  mockTxnUpdate,
  mockIncrement,
  mockTimestampFromMillis,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDoc: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockTxnGet: vi.fn(),
  mockTxnSet: vi.fn(),
  mockTxnUpdate: vi.fn(),
  mockIncrement: vi.fn((n: number) => ({ _increment: n })),
  mockTimestampFromMillis: vi.fn((ms: number) => ({ _timestamp: ms })),
  mockLoggerWarn: vi.fn(),
}))

vi.mock('firebase-admin', () => {
  const firestoreFn = () => ({
    collection: mockCollection.mockReturnValue({ doc: mockDoc }),
    runTransaction: mockRunTransaction,
  })
  firestoreFn.FieldValue = { increment: mockIncrement }
  firestoreFn.Timestamp = { fromMillis: mockTimestampFromMillis }

  return {
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
  }
})

vi.mock('firebase-functions', () => {
  class HttpsError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
      this.name = 'HttpsError'
    }
  }
  return {
    default: { https: { HttpsError }, logger: { warn: mockLoggerWarn } },
    https: { HttpsError },
    logger: { warn: mockLoggerWarn },
  }
})

// ---------------------------------------------------------------------------
// Under test
// ---------------------------------------------------------------------------

import { withRateLimit } from '../withRateLimit'

const NOW = 1_700_000_000_000 // fixed epoch for deterministic expiresAt math

function makeContext(uid = 'user-abc') {
  return { auth: { uid } } as unknown as Parameters<Parameters<typeof withRateLimit>[1]>[1]
}

describe('withRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    // Default: docRef passed into every runTransaction is fresh
    mockDoc.mockReturnValue({ id: 'createPaymentIntent:uid:user-abc' })
    mockRunTransaction.mockImplementation(async (cb) =>
      cb({ get: mockTxnGet, set: mockTxnSet, update: mockTxnUpdate }),
    )
  })

  // -------------------------------------------------------------------------
  // Fresh bucket — set path
  // -------------------------------------------------------------------------

  describe('fresh bucket (txn.set)', () => {
    it('writes expiresAt = Timestamp.fromMillis(now + windowMs * 2) on first request', async () => {
      mockTxnGet.mockResolvedValueOnce({ exists: false, data: () => undefined })

      const handler = vi.fn().mockResolvedValue({ ok: true })
      const wrapped = withRateLimit({ name: 'createPaymentIntent', windowMs: 60_000, max: 5 }, handler)

      const result = await wrapped({ amount: 100 }, makeContext())

      expect(result).toEqual({ ok: true })
      expect(mockTxnSet).toHaveBeenCalledTimes(1)
      const setArgs = mockTxnSet.mock.calls[0]?.[1] as Record<string, unknown>
      expect(setArgs.count).toBe(1)
      expect(setArgs.firstAt).toBe(NOW)
      expect(setArgs.lastAt).toBe(NOW)
      expect(mockTimestampFromMillis).toHaveBeenCalledWith(NOW + 60_000 * 2)
      expect(setArgs.expiresAt).toEqual({ _timestamp: NOW + 60_000 * 2 })
    })

    it('treats a stale bucket (firstAt < windowStart) as fresh and resets expiresAt', async () => {
      const windowMs = 60_000
      const staleFirstAt = NOW - windowMs * 10 // way outside the window
      mockTxnGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ count: 99, firstAt: staleFirstAt, lastAt: staleFirstAt }),
      })

      const handler = vi.fn().mockResolvedValue('ok')
      const wrapped = withRateLimit({ name: 'test', windowMs, max: 5 }, handler)

      await wrapped({}, makeContext())

      expect(mockTxnSet).toHaveBeenCalledTimes(1)
      const setArgs = mockTxnSet.mock.calls[0]?.[1] as Record<string, unknown>
      expect(setArgs.count).toBe(1)
      expect(setArgs.firstAt).toBe(NOW)
      // Anchor resets to NOW because bucket was stale
      expect(mockTimestampFromMillis).toHaveBeenCalledWith(NOW + windowMs * 2)
      expect(setArgs.expiresAt).toEqual({ _timestamp: NOW + windowMs * 2 })
    })
  })

  // -------------------------------------------------------------------------
  // Rolling update — update path
  // -------------------------------------------------------------------------

  describe('rolling update (txn.update)', () => {
    it('anchors expiresAt on existing firstAt, not now (prevents client-driven TTL slide)', async () => {
      const windowMs = 60_000
      const firstAt = NOW - 10_000 // bucket opened 10s ago, still inside window

      mockTxnGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ count: 2, firstAt, lastAt: NOW - 5_000 }),
      })

      const handler = vi.fn().mockResolvedValue('ok')
      const wrapped = withRateLimit({ name: 'rolling', windowMs, max: 5 }, handler)

      await wrapped({}, makeContext())

      expect(mockTxnSet).not.toHaveBeenCalled()
      expect(mockTxnUpdate).toHaveBeenCalledTimes(1)
      const updateArgs = mockTxnUpdate.mock.calls[0]?.[1] as Record<string, unknown>
      expect(updateArgs.count).toEqual({ _increment: 1 })
      expect(updateArgs.lastAt).toBe(NOW)
      // Anchor on firstAt, NOT now — otherwise a spammer could extend TTL indefinitely
      expect(mockTimestampFromMillis).toHaveBeenCalledWith(firstAt + windowMs * 2)
      expect(updateArgs.expiresAt).toEqual({ _timestamp: firstAt + windowMs * 2 })
    })
  })

  // -------------------------------------------------------------------------
  // Rate-limit exceeded
  // -------------------------------------------------------------------------

  describe('rate-limit exceeded', () => {
    it('throws HttpsError resource-exhausted when count >= max', async () => {
      const windowMs = 60_000
      mockTxnGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ count: 5, firstAt: NOW - 1_000, lastAt: NOW - 500 }),
      })

      const handler = vi.fn().mockResolvedValue('ok')
      const wrapped = withRateLimit({ name: 'maxed', windowMs, max: 5 }, handler)

      await expect(wrapped({}, makeContext())).rejects.toMatchObject({
        name: 'HttpsError',
        code: 'resource-exhausted',
      })

      // No write happened; handler NOT invoked
      expect(mockTxnSet).not.toHaveBeenCalled()
      expect(mockTxnUpdate).not.toHaveBeenCalled()
      expect(handler).not.toHaveBeenCalled()
    })

    it('with logOnly=true, warns but still invokes the handler', async () => {
      mockTxnGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({ count: 10, firstAt: NOW - 1_000, lastAt: NOW - 500 }),
      })

      const handler = vi.fn().mockResolvedValue('allowed-through')
      const wrapped = withRateLimit(
        { name: 'soft', windowMs: 60_000, max: 5, logOnly: true },
        handler,
      )

      const result = await wrapped({}, makeContext())
      expect(result).toBe('allowed-through')
      expect(mockLoggerWarn).toHaveBeenCalledWith('[rate-limit] exceeded', expect.any(Object))
      expect(handler).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Fail-open on Firestore error
  // -------------------------------------------------------------------------

  describe('Firestore transaction error', () => {
    it('fails open — logs a warning and invokes the handler anyway', async () => {
      mockRunTransaction.mockRejectedValueOnce(new Error('Firestore unavailable'))

      const handler = vi.fn().mockResolvedValue('fail-open')
      const wrapped = withRateLimit({ name: 'flaky', windowMs: 60_000, max: 5 }, handler)

      const result = await wrapped({}, makeContext())
      expect(result).toBe('fail-open')
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[rate-limit] firestore error; failing open',
        expect.any(Object),
      )
      expect(handler).toHaveBeenCalledWith({}, expect.any(Object))
    })
  })

  // -------------------------------------------------------------------------
  // Unauthenticated caller still gets a key
  // -------------------------------------------------------------------------

  describe('key builder', () => {
    it('defaults to uid:anon when context.auth is missing', async () => {
      mockTxnGet.mockResolvedValueOnce({ exists: false, data: () => undefined })

      const handler = vi.fn().mockResolvedValue('ok')
      const wrapped = withRateLimit({ name: 'anon-ok', windowMs: 60_000, max: 5 }, handler)

      await wrapped({}, { auth: undefined } as unknown as ReturnType<typeof makeContext>)

      expect(mockDoc).toHaveBeenCalledWith('anon-ok:uid:anon')
    })

    it('respects a custom keyBy override', async () => {
      mockTxnGet.mockResolvedValueOnce({ exists: false, data: () => undefined })

      const handler = vi.fn().mockResolvedValue('ok')
      const wrapped = withRateLimit(
        {
          name: 'per-ip',
          windowMs: 60_000,
          max: 5,
          keyBy: () => 'ip:203.0.113.7',
        },
        handler,
      )

      await wrapped({}, makeContext())

      expect(mockDoc).toHaveBeenCalledWith('per-ip:ip:203.0.113.7')
    })
  })
})
