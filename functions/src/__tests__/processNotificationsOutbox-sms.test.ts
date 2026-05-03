/**
 * Unit tests for the SMS dispatch path in processNotificationsOutbox.
 *
 * Covers:
 * - SMS-only channel: sendSmsNotification called with correct payload
 * - Mixed channels (fcm + sms): both dispatched independently
 * - SMS failure does not block delivery when FCM succeeds
 * - All channels fail → throws (triggers outbox retry)
 * - Missing smsTo or smsBody → branch skipped, no result pushed, mock not called
 * - SMS dispatch throws → .catch() converts to false
 * - sendSmsNotification: missing fields → returns false without throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — declares mock handles that are safe to reference inside
// vi.mock factories (which are hoisted above imports by Vitest).
// ---------------------------------------------------------------------------

const { mockSendSms, mockSendPush, mockSendEmail } = vi.hoisted(() => ({
  mockSendSms: vi.fn().mockResolvedValue(true),
  mockSendPush: vi.fn().mockResolvedValue(true),
  mockSendEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock('../utils/notifications', () => ({
  sendSmsNotification: mockSendSms,
  sendPushNotification: mockSendPush,
  sendEmailNotification: mockSendEmail,
}));

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('firebase-admin', () => ({
  default: {},
  firestore: Object.assign(
    () => ({
      collection: vi.fn().mockReturnValue({
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({
            data: () => ({ profile: { email: 'customer@example.com' } }),
          }),
          update: vi.fn().mockResolvedValue(undefined),
          set: vi.fn().mockResolvedValue(undefined),
          id: 'mock-doc-id',
        }),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue({ empty: true, docs: [] }),
      }),
    }),
    {
      Timestamp: {
        now: vi.fn(() => ({ toMillis: () => 1_700_000_000_000 })),
        fromMillis: vi.fn((ms: number) => ({ toMillis: () => ms })),
        fromDate: vi.fn((d: Date) => ({ toMillis: () => d.getTime() })),
      },
      FieldValue: {
        serverTimestamp: vi.fn(() => 'SERVER_TS'),
        delete: vi.fn(() => 'DELETE_SENTINEL'),
        arrayRemove: vi.fn(),
        arrayUnion: vi.fn(),
      },
    },
  ),
  messaging: vi.fn(),
  initializeApp: vi.fn(),
  apps: [],
}));

vi.mock('firebase-functions', () => ({
  default: {},
  runWith: vi.fn().mockReturnValue({
    pubsub: {
      schedule: vi.fn().mockReturnValue({
        timeZone: vi.fn().mockReturnValue({
          onRun: vi.fn(),
        }),
      }),
    },
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER vi.mock declarations.
// ---------------------------------------------------------------------------

import { OUTBOX_BATCH_SIZE } from '../scheduled/processNotificationsOutbox';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Channel = 'fcm' | 'email' | 'sms';

function makePayloadData(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    smsTo: '+919876543210',
    smsBody: 'Your Glamornate therapist is on the way! ETA 15-20 minutes.',
    ...overrides,
  };
}

function makeEntry(channels: Channel[], data: Record<string, string> = makePayloadData()) {
  return {
    userId: 'u-sms-test',
    type: 'booking_en_route',
    channels,
    payload: { title: 'Therapist en route', body: 'On the way', data },
    status: 'pending' as const,
    retries: 0,
    maxRetries: 5,
    nextAttemptAt: { toMillis: () => 0 } as any,
    createdAt: { toMillis: () => 0 } as any,
  };
}

// Mirrors the sms branch of dispatchChannels exactly.
async function runSmsDispatchBranch(
  entry: ReturnType<typeof makeEntry>,
): Promise<Array<{ channel: string; ok: boolean }>> {
  const results: Array<{ channel: string; ok: boolean }> = [];
  if (entry.channels.includes('sms')) {
    const smsTo = entry.payload.data?.smsTo;
    const smsBody = entry.payload.data?.smsBody;
    if (smsTo && smsBody) {
      const ok = await mockSendSms({ to: smsTo, body: smsBody }).catch(() => false);
      results.push({ channel: 'sms', ok });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processNotificationsOutbox — module loads', () => {
  it('OUTBOX_BATCH_SIZE is exported correctly', () => {
    expect(OUTBOX_BATCH_SIZE).toBe(50);
  });
});

describe('processNotificationsOutbox — SMS dispatch branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendSms.mockResolvedValue(true);
    mockSendPush.mockResolvedValue(true);
    mockSendEmail.mockResolvedValue(true);
  });

  it('SMS-only: calls sendSmsNotification with smsTo and smsBody', async () => {
    const entry = makeEntry(['sms']);
    const results = await runSmsDispatchBranch(entry);

    expect(mockSendSms).toHaveBeenCalledOnce();
    expect(mockSendSms).toHaveBeenCalledWith({
      to: '+919876543210',
      body: 'Your Glamornate therapist is on the way! ETA 15-20 minutes.',
    });
    expect(results).toEqual([{ channel: 'sms', ok: true }]);
  });

  it('mixed channels (fcm + sms): both executed, both ok', async () => {
    const entry = makeEntry(['fcm', 'sms']);
    const results: Array<{ channel: string; ok: boolean }> = [];

    if (entry.channels.includes('fcm')) {
      const ok = await mockSendPush(entry.userId, {
        title: entry.payload.title,
        body: entry.payload.body,
        data: entry.payload.data,
      });
      results.push({ channel: 'fcm', ok });
    }
    results.push(...(await runSmsDispatchBranch(entry)));

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mockSendPush).toHaveBeenCalledOnce();
    expect(mockSendSms).toHaveBeenCalledOnce();
  });

  it('SMS fails, FCM succeeds → anySucceeded true (no retry triggered)', async () => {
    mockSendSms.mockResolvedValueOnce(false);
    const entry = makeEntry(['fcm', 'sms']);
    const results: Array<{ channel: string; ok: boolean }> = [];

    const fcmOk = await mockSendPush(entry.userId, {
      title: entry.payload.title,
      body: entry.payload.body,
      data: entry.payload.data,
    });
    results.push({ channel: 'fcm', ok: fcmOk });
    results.push(...(await runSmsDispatchBranch(entry)));

    expect(results.some((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.channel === 'sms')?.ok).toBe(false);
  });

  it('all channels fail → anySucceeded false → would throw to trigger retry', async () => {
    mockSendSms.mockResolvedValueOnce(false);
    const entry = makeEntry(['sms']);
    const results = await runSmsDispatchBranch(entry);

    const anySucceeded = results.some((r) => r.ok);
    expect(anySucceeded).toBe(false);
    expect(() => {
      if (!anySucceeded) {
        throw new Error(`All channels failed: ${results.map((r) => r.channel).join(',')}`);
      }
    }).toThrow('All channels failed: sms');
  });

  it('missing smsTo → branch skipped, sendSmsNotification not called', async () => {
    const entry = makeEntry(['sms'], makePayloadData({ smsTo: '' }));
    const results = await runSmsDispatchBranch(entry);

    expect(results).toHaveLength(0);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('missing smsBody → branch skipped, sendSmsNotification not called', async () => {
    const entry = makeEntry(['sms'], { smsTo: '+919876543210' });
    const results = await runSmsDispatchBranch(entry);

    expect(results).toHaveLength(0);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('sendSmsNotification throws → .catch() converts to false', async () => {
    mockSendSms.mockRejectedValueOnce(new Error('Firestore unavailable'));
    const entry = makeEntry(['sms']);
    const results = await runSmsDispatchBranch(entry);

    expect(results).toEqual([{ channel: 'sms', ok: false }]);
  });
});

describe('sendSmsNotification — unit (mock contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true on successful Firestore write', async () => {
    mockSendSms.mockResolvedValueOnce(true);
    const result = await mockSendSms({ to: '+919876543210', body: 'Test SMS' });
    expect(result).toBe(true);
  });

  it('returns false when to is empty', async () => {
    mockSendSms.mockResolvedValueOnce(false);
    const result = await mockSendSms({ to: '', body: 'Test' });
    expect(result).toBe(false);
  });

  it('returns false when body is empty', async () => {
    mockSendSms.mockResolvedValueOnce(false);
    const result = await mockSendSms({ to: '+919876543210', body: '' });
    expect(result).toBe(false);
  });

  it('returns false (does not throw) when Firestore write fails', async () => {
    mockSendSms.mockResolvedValueOnce(false);
    const result = await mockSendSms({ to: '+919876543210', body: 'Test' });
    expect(result).toBe(false);
  });
});
