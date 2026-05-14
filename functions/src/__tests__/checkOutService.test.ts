/**
 * Tests for the checkOutService callable Cloud Function.
 *
 * Phase 3.5 V-6 fix lock (Round 1, 2026-05-08): the precondition gate
 * was previously `['en_route', 'in_service']`, where `'in_service'` is
 * a phantom string that does not exist in the schema or rules. Customers
 * reaching `in_progress` (via spa_owner/spa_staff direct write per
 * firestore.rules:252-264) could not be checked out — failed-precondition
 * every time, forcing cancelBooking and full refund for delivered service.
 *
 * This file locks the corrected enum `['en_route', 'in_progress']` against
 * future regression.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGet,
  mockUpdate,
  mockDocFn,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockDocFn: vi.fn(),
}));

vi.mock('firebase-admin', () => {
  const collection = vi.fn().mockImplementation(() => ({ doc: mockDocFn }));
  const firestoreInstance = { collection };
  const firestoreFn = () => firestoreInstance;
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 1700000000, toDate: () => new Date(1700000000000) }),
  };
  firestoreFn.FieldValue = {
    serverTimestamp: () => 'SERVER_TIMESTAMP',
    arrayUnion: (...args: unknown[]) => ({ _arrayUnion: args }),
    increment: (n: number) => ({ _inc: n }),
  };
  return { default: { firestore: firestoreFn }, firestore: firestoreFn };
});

vi.mock('firebase-functions', () => {
  class HttpsError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.name = 'HttpsError';
      this.code = code;
      this.details = details;
    }
  }
  const https = { HttpsError, onCall: (handler: unknown) => handler };
  return { default: { https }, https };
});

vi.mock('../utils/callable-opts', () => ({
  callableOpts: () => ({ https: { onCall: (handler: unknown) => handler } }),
}));

vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock('../utils/error-handler', () => ({
  handleError: (e: unknown) => e,
}));

import { checkOutService } from '../callable/checkOutService';

const buildBookingDoc = (overrides: Record<string, unknown> = {}) => ({
  exists: true,
  ref: { update: mockUpdate },
  data: () => ({
    bookingStatus: 'in_progress',
    spaId: 'spa-1',
    therapistId: 'therapist-1',
    pricing: { total: 1500 },
    ...overrides,
  }),
});

const buildUserDoc = (overrides: Record<string, unknown> = {}) => ({
  exists: true,
  data: () => ({ role: 'spa_owner', spaData: { spaId: 'spa-1' }, ...overrides }),
});

const wireDocLookups = (booking: ReturnType<typeof buildBookingDoc>, user: ReturnType<typeof buildUserDoc>) => {
  // First .doc() call resolves to booking; second to user.
  mockDocFn.mockReset();
  mockGet.mockReset();
  mockDocFn
    .mockReturnValueOnce({ get: () => Promise.resolve(booking) })
    .mockReturnValueOnce({ get: () => Promise.resolve(user) })
    // Subsequent calls (spa stats / therapist stats) — return a doc with .update no-op
    .mockReturnValue({ update: vi.fn().mockResolvedValue(undefined) });
};

describe('checkOutService — V-6 gate fix lock (SC-2 customer flow + spa revenue)', () => {
  beforeEach(() => {
    mockUpdate.mockReset();
    mockUpdate.mockResolvedValue(undefined);
  });

  it('ALLOWS check-out when bookingStatus is in_progress (V-6 fix)', async () => {
    wireDocLookups(buildBookingDoc({ bookingStatus: 'in_progress' }), buildUserDoc());
    const result = await (checkOutService as unknown as Function)(
      { bookingId: 'b-1' },
      { auth: { uid: 'staff-1' } },
    );
    expect(result).toEqual({ success: true });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ bookingStatus: 'completed' }),
    );
  });

  it('ALLOWS check-out when bookingStatus is en_route (existing path preserved)', async () => {
    wireDocLookups(buildBookingDoc({ bookingStatus: 'en_route' }), buildUserDoc());
    const result = await (checkOutService as unknown as Function)(
      { bookingId: 'b-1' },
      { auth: { uid: 'staff-1' } },
    );
    expect(result).toEqual({ success: true });
  });

  it('REJECTS phantom in_service (regression lock — must never be re-added)', async () => {
    wireDocLookups(buildBookingDoc({ bookingStatus: 'in_service' }), buildUserDoc());
    let thrown: { code?: string; message?: string } | null = null;
    try {
      await (checkOutService as unknown as Function)(
        { bookingId: 'b-1' },
        { auth: { uid: 'staff-1' } },
      );
    } catch (e) {
      thrown = e as { code?: string; message?: string };
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe('failed-precondition');
  });

  it('REJECTS check-out when bookingStatus is confirmed (gate working as intended)', async () => {
    wireDocLookups(buildBookingDoc({ bookingStatus: 'confirmed' }), buildUserDoc());
    let thrown: { code?: string; message?: string } | null = null;
    try {
      await (checkOutService as unknown as Function)(
        { bookingId: 'b-1' },
        { auth: { uid: 'staff-1' } },
      );
    } catch (e) {
      thrown = e as { code?: string; message?: string };
    }
    expect(thrown?.code).toBe('failed-precondition');
  });

  it('REJECTS check-out when bookingStatus is completed (already terminal)', async () => {
    wireDocLookups(buildBookingDoc({ bookingStatus: 'completed' }), buildUserDoc());
    let thrown: { code?: string; message?: string } | null = null;
    try {
      await (checkOutService as unknown as Function)(
        { bookingId: 'b-1' },
        { auth: { uid: 'staff-1' } },
      );
    } catch (e) {
      thrown = e as { code?: string; message?: string };
    }
    expect(thrown?.code).toBe('failed-precondition');
  });
});
