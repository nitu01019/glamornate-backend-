/**
 * Integration test for `withRateLimit` — verifies the wrapper actually
 * short-circuits with `resource-exhausted` when the bucket is full and that
 * `logOnly: true` mode never throws.
 *
 * Strategy: rather than spinning up the Firestore emulator, we mock
 * `admin.firestore().runTransaction()` to return the boolean the wrapper
 * expects (true = allowed, false = denied). This isolates the wrapper's
 * gating + HttpsError shape from the Firestore transaction internals.
 *
 * NOTE: This file deliberately does NOT mock `../utils/withRateLimit` — it
 * imports the real module. Every other Phase 2 callable test mocks the
 * wrapper as a pass-through; this is the one place we exercise the real
 * thing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks for firebase-admin/firebase-functions
// ---------------------------------------------------------------------------

const { mockRunTransaction, mockDoc, mockCollection } = vi.hoisted(() => ({
  mockRunTransaction: vi.fn(),
  mockDoc: vi.fn(() => ({ id: 'rate-limit-doc' })),
  mockCollection: vi.fn(() => ({ doc: () => ({ id: 'rate-limit-doc' }) })),
}))

vi.mock('firebase-admin', () => {
  const Timestamp = {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  }
  const FieldValue = {
    increment: (n: number) => ({ __op: 'increment', n }),
  }
  const firestore = Object.assign(
    () => ({
      collection: mockCollection,
      runTransaction: mockRunTransaction,
    }),
    { Timestamp, FieldValue },
  )
  return {
    firestore,
    default: { firestore },
  }
})

vi.mock('firebase-functions', () => {
  class HttpsError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    https: { HttpsError },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

// ---------------------------------------------------------------------------
// Real module under test (NO vi.mock for withRateLimit here)
// ---------------------------------------------------------------------------

import { withRateLimit } from '../utils/withRateLimit'
import * as functions from 'firebase-functions'

const fakeContext = { auth: { uid: 'user-1' } } as unknown as Parameters<
  Parameters<typeof withRateLimit>[1]
>[1]

describe('withRateLimit (real module)', () => {
  beforeEach(() => {
    mockRunTransaction.mockReset()
    mockDoc.mockClear()
    mockCollection.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('throws HttpsError(resource-exhausted) when the bucket is full', async () => {
    // Simulate the runTransaction body returning `false` (count >= max).
    mockRunTransaction.mockResolvedValueOnce(false)

    const handler = vi.fn().mockResolvedValue('ok')
    const wrapped = withRateLimit(
      { name: 'test-bucket', windowMs: 60_000, max: 1 },
      handler,
    )

    await expect(wrapped({}, fakeContext)).rejects.toMatchObject({
      code: 'resource-exhausted',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does NOT throw in logOnly mode even when the bucket is full', async () => {
    mockRunTransaction.mockResolvedValueOnce(false)

    const handler = vi.fn().mockResolvedValue('ok-logonly')
    const wrapped = withRateLimit(
      { name: 'test-bucket-log', windowMs: 60_000, max: 1, logOnly: true },
      handler,
    )

    const result = await wrapped({}, fakeContext)
    expect(result).toBe('ok-logonly')
    expect(handler).toHaveBeenCalledTimes(1)
    // Wrapper still emits a warning when threshold is crossed.
    expect(functions.logger.warn).toHaveBeenCalled()
  })

  it('passes through to the handler when the bucket has capacity', async () => {
    mockRunTransaction.mockResolvedValueOnce(true)

    const handler = vi.fn().mockResolvedValue('ok-allowed')
    const wrapped = withRateLimit(
      { name: 'test-bucket-ok', windowMs: 60_000, max: 10 },
      handler,
    )

    const result = await wrapped({ foo: 1 }, fakeContext)
    expect(result).toBe('ok-allowed')
    expect(handler).toHaveBeenCalledWith({ foo: 1 }, fakeContext)
  })
})
