import { describe, it, expect, vi } from 'vitest'

// Mock firebase-functions *before* importing the module under test.
// We provide just enough structure to let handleError compile and run.
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
  return {
    default: {},
    https: { HttpsError },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }
})

import { handleError, createError, AppError, ErrorCode } from '../../src/utils/error-handler'
import { z } from 'zod'

// =============================================================================
// AppError
// =============================================================================
describe('AppError', () => {
  it('should store code, message, statusCode and details', () => {
    const err = new AppError(ErrorCode.NOT_FOUND, 'Spa not found', 404, { spaId: '123' })
    expect(err.code).toBe(ErrorCode.NOT_FOUND)
    expect(err.message).toBe('Spa not found')
    expect(err.statusCode).toBe(404)
    expect(err.details).toEqual({ spaId: '123' })
    expect(err.name).toBe('AppError')
  })

  it('should default statusCode to 500', () => {
    const err = new AppError(ErrorCode.INTERNAL_ERROR, 'boom')
    expect(err.statusCode).toBe(500)
  })
})

// =============================================================================
// createError
// =============================================================================
describe('createError', () => {
  it('should produce an AppError with correct code and default message', () => {
    const err = createError(ErrorCode.AUTH_MISSING)
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe(ErrorCode.AUTH_MISSING)
    expect(err.message).toBe('Authentication required')
    expect(err.statusCode).toBe(401)
  })

  it('should allow a custom message', () => {
    const err = createError(ErrorCode.NOT_FOUND, 'Booking not found')
    expect(err.message).toBe('Booking not found')
    expect(err.statusCode).toBe(404)
  })

  it('should carry details', () => {
    const err = createError(ErrorCode.VALIDATION_ERROR, undefined, { field: 'email' })
    expect(err.details).toEqual({ field: 'email' })
  })

  it('should map each ErrorCode to the correct status code', () => {
    const mappings: Array<[ErrorCode, number]> = [
      [ErrorCode.AUTH_MISSING, 401],
      [ErrorCode.AUTH_INVALID, 401],
      [ErrorCode.FORBIDDEN, 403],
      [ErrorCode.NOT_FOUND, 404],
      [ErrorCode.VALIDATION_ERROR, 400],
      [ErrorCode.SLOT_UNAVAILABLE, 409],
      [ErrorCode.PAYMENT_FAILED, 402],
      [ErrorCode.DUPLICATE_BOOKING, 409],
      [ErrorCode.RATE_LIMITED, 429],
      [ErrorCode.INTERNAL_ERROR, 500],
    ]
    for (const [code, expectedStatus] of mappings) {
      const err = createError(code)
      expect(err.statusCode).toBe(expectedStatus)
    }
  })
})

// =============================================================================
// handleError
// =============================================================================
describe('handleError', () => {
  it('should convert an AppError to an HttpsError with the correct code', () => {
    const appErr = new AppError(ErrorCode.NOT_FOUND, 'Spa missing', 404)
    const httpsErr = handleError(appErr)
    expect(httpsErr.message).toBe('Spa missing')
    expect((httpsErr as any).code).toBe('not-found')
  })

  it('should convert a Zod validation error to an invalid-argument HttpsError', () => {
    const schema = z.object({ email: z.string().email() })
    let zodErr: z.ZodError | undefined
    try { schema.parse({ email: 'not-an-email' }) } catch (e) { zodErr = e as z.ZodError }

    const httpsErr = handleError(zodErr!)
    expect((httpsErr as any).code).toBe('invalid-argument')
    expect(httpsErr.message).toBe('Validation failed')
  })

  it('should pass through an existing HttpsError', async () => {
    const { https } = await import('firebase-functions')
    const original = new https.HttpsError('permission-denied', 'No access')
    const result = handleError(original)
    expect(result).toBe(original)
  })

  it('should wrap a generic Error as an internal HttpsError', () => {
    const result = handleError(new Error('unexpected'))
    expect((result as any).code).toBe('internal')
    expect(result.message).toBe('An internal error occurred')
  })

  it('should wrap non-Error values as internal HttpsError', () => {
    const result = handleError('string error')
    expect((result as any).code).toBe('internal')
  })

  it('should map status codes to the correct HttpsError code', () => {
    const cases: Array<[number, string]> = [
      [400, 'invalid-argument'],
      [401, 'unauthenticated'],
      [403, 'permission-denied'],
      [404, 'not-found'],
      [409, 'already-exists'],
      [429, 'resource-exhausted'],
      [500, 'internal'],
    ]
    for (const [status, expectedCode] of cases) {
      const err = new AppError(ErrorCode.INTERNAL_ERROR, 'test', status)
      const result = handleError(err)
      expect((result as any).code).toBe(expectedCode)
    }
  })
})

