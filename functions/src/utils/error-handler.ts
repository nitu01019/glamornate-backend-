import * as functions from 'firebase-functions';
import { z } from 'zod';
import { createLogger } from './logger';

const logger = createLogger('error-handler');

export enum ErrorCode {
  AUTH_MISSING = 'AUTH_MISSING',
  AUTH_INVALID = 'AUTH_INVALID',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  SLOT_UNAVAILABLE = 'SLOT_UNAVAILABLE',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  DUPLICATE_BOOKING = 'DUPLICATE_BOOKING',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function handleError(error: unknown): functions.https.HttpsError {
  logger.error('Error encountered:', error);

  // Handle AppError
  if (error instanceof AppError) {
    return new functions.https.HttpsError(
      mapStatusCodeToHttpsErrorCode(error.statusCode),
      error.message,
      { code: error.code, details: error.details }
    );
  }

  // Handle Zod validation errors
  if (error instanceof z.ZodError) {
    return new functions.https.HttpsError(
      'invalid-argument',
      'Validation failed',
      { code: ErrorCode.VALIDATION_ERROR, errors: error.errors }
    );
  }

  // Handle Firebase functions errors (rethrow)
  if (error instanceof functions.https.HttpsError) {
    return error;
  }

  // Handle generic errors — log the real message but return a safe message to the client
  if (error instanceof Error) {
    logger.error('Unhandled error:', { name: error.name, message: error.message, stack: error.stack });
  }
  return new functions.https.HttpsError(
    'internal',
    'An internal error occurred',
    { code: ErrorCode.INTERNAL_ERROR }
  );
}

function mapStatusCodeToHttpsErrorCode(statusCode: number) {
  switch (statusCode) {
    case 400:
      return 'invalid-argument' as const;
    case 401:
      return 'unauthenticated' as const;
    case 403:
      return 'permission-denied' as const;
    case 404:
      return 'not-found' as const;
    case 409:
      return 'already-exists' as const;
    case 429:
      return 'resource-exhausted' as const;
    default:
      return 'internal' as const;
  }
}

export function createError(code: ErrorCode, message?: string, details?: Record<string, unknown>): AppError {
  const messages: Record<ErrorCode, string> = {
    [ErrorCode.AUTH_MISSING]: 'Authentication required',
    [ErrorCode.AUTH_INVALID]: 'Invalid or expired authentication',
    [ErrorCode.FORBIDDEN]: 'Insufficient permissions',
    [ErrorCode.NOT_FOUND]: 'Resource not found',
    [ErrorCode.VALIDATION_ERROR]: 'Invalid request data',
    [ErrorCode.SLOT_UNAVAILABLE]: 'This time slot is no longer available',
    [ErrorCode.PAYMENT_FAILED]: 'Payment processing failed',
    [ErrorCode.DUPLICATE_BOOKING]: 'You already have a booking at this time',
    [ErrorCode.RATE_LIMITED]: 'Too many requests. Please try again later.',
    [ErrorCode.INTERNAL_ERROR]: 'An internal error occurred',
  };

  const statusCodes: Record<ErrorCode, number> = {
    [ErrorCode.AUTH_MISSING]: 401,
    [ErrorCode.AUTH_INVALID]: 401,
    [ErrorCode.FORBIDDEN]: 403,
    [ErrorCode.NOT_FOUND]: 404,
    [ErrorCode.VALIDATION_ERROR]: 400,
    [ErrorCode.SLOT_UNAVAILABLE]: 409,
    [ErrorCode.PAYMENT_FAILED]: 402,
    [ErrorCode.DUPLICATE_BOOKING]: 409,
    [ErrorCode.RATE_LIMITED]: 429,
    [ErrorCode.INTERNAL_ERROR]: 500,
  };

  return new AppError(code, message || messages[code], statusCodes[code], details);
}
