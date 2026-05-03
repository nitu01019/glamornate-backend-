/**
 * Unit tests for the notifications outbox helper (B7).
 *
 * Scope: `enqueueNotification` shape + `computeBackoffMs` math. The
 * scheduled worker in `scheduled/processNotificationsOutbox.ts` is
 * exercised via the firebase-functions-test emulator path (not covered
 * here — Phase 5 will add an integration test once call sites migrate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCollection, mockDoc, mockSet } = vi.hoisted(() => ({
  mockCollection: vi.fn(),
  mockDoc: vi.fn(),
  mockSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('firebase-admin', () => ({
  firestore: Object.assign(
    () => ({
      collection: mockCollection,
    }),
    {
      Timestamp: {
        now: vi.fn(() => ({ toMillis: () => 1_700_000_000_000, seconds: 1700000000 })),
        fromDate: vi.fn((d: Date) => ({ toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000) })),
      },
    },
  ),
}));

describe('notifications-outbox helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.mockReturnValue({ doc: mockDoc });
    mockDoc.mockReturnValue({ id: 'outbox-abc123', set: mockSet });
  });

  it('enqueues a pending row with sensible defaults', async () => {
    const { enqueueNotification, OUTBOX_COLLECTION, OUTBOX_DEFAULT_MAX_RETRIES } =
      await import('../utils/notifications-outbox');

    const id = await enqueueNotification({
      userId: 'u-1',
      type: 'booking-confirmed',
      channels: ['fcm', 'email'],
      payload: { title: 'Hi', body: 'Body' },
    });

    expect(id).toBe('outbox-abc123');
    expect(mockCollection).toHaveBeenCalledWith(OUTBOX_COLLECTION);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        type: 'booking-confirmed',
        channels: ['fcm', 'email'],
        status: 'pending',
        retries: 0,
        maxRetries: OUTBOX_DEFAULT_MAX_RETRIES,
        payload: expect.objectContaining({ title: 'Hi', body: 'Body', data: {} }),
      }),
    );
  });

  it('rejects empty channel list', async () => {
    const { enqueueNotification } = await import('../utils/notifications-outbox');
    await expect(
      enqueueNotification({
        userId: 'u-1',
        type: 'other',
        channels: [],
        payload: { title: 't', body: 'b' },
      }),
    ).rejects.toThrow(/at least one channel/);
  });

  it('honours custom maxRetries', async () => {
    const { enqueueNotification } = await import('../utils/notifications-outbox');
    await enqueueNotification({
      userId: 'u-2',
      type: 'reminder',
      channels: ['sms'],
      payload: { title: 't', body: 'b' },
      maxRetries: 10,
    });
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 10 }));
  });

  it('computeBackoffMs caps at 60s and grows exponentially', async () => {
    const { computeBackoffMs } = await import('../utils/notifications-outbox');

    expect(computeBackoffMs(1)).toBe(2_000);
    expect(computeBackoffMs(2)).toBe(4_000);
    expect(computeBackoffMs(3)).toBe(8_000);
    expect(computeBackoffMs(6)).toBe(60_000);
    // Beyond cap, stays at cap.
    expect(computeBackoffMs(10)).toBe(60_000);
  });
});

/**
 * Tests for `enqueueNotificationFromContext` — the adapter that legacy
 * callers use to migrate off `sendMultiChannelNotification` without
 * restructuring their payload shape.
 */
describe('enqueueNotificationFromContext adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.mockReturnValue({ doc: mockDoc });
    mockDoc.mockReturnValue({ id: 'outbox-adapter-1', set: mockSet });
  });

  it('maps push channel to fcm and enqueues with the push payload', async () => {
    const { enqueueNotificationFromContext } = await import(
      '../utils/notifications-outbox'
    );

    const id = await enqueueNotificationFromContext({
      userId: 'u-1',
      type: 'booking_confirmed',
      channels: { push: true, email: false, sms: false },
      push: {
        title: 'Booking Confirmed!',
        body: 'Your appointment is confirmed',
        data: { bookingId: 'b-1' },
      },
    });

    expect(id).toBe('outbox-adapter-1');
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        type: 'booking_confirmed',
        channels: ['fcm'],
        status: 'pending',
        retries: 0,
        payload: expect.objectContaining({
          title: 'Booking Confirmed!',
          body: 'Your appointment is confirmed',
          data: expect.objectContaining({ bookingId: 'b-1' }),
        }),
      }),
    );
  });

  it('includes email/sms channels only when recipient addresses are provided', async () => {
    const { enqueueNotificationFromContext } = await import(
      '../utils/notifications-outbox'
    );

    await enqueueNotificationFromContext({
      userId: 'u-2',
      type: 'booking_cancelled',
      channels: { push: true, email: true, sms: true },
      push: { title: 'Cancelled', body: 'Your booking was cancelled' },
      email: { to: 'user@example.com', subject: 'Cancelled', templateId: 'tpl_1' },
      sms: { to: '+15551234', body: 'Cancelled' },
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: ['fcm', 'email', 'sms'],
        payload: expect.objectContaining({
          data: expect.objectContaining({
            emailTo: 'user@example.com',
            emailSubject: 'Cancelled',
            emailTemplateId: 'tpl_1',
            smsTo: '+15551234',
            smsBody: 'Cancelled',
          }),
        }),
      }),
    );
  });

  it('drops email/sms channels silently when recipient address missing', async () => {
    const { enqueueNotificationFromContext } = await import(
      '../utils/notifications-outbox'
    );

    await enqueueNotificationFromContext({
      userId: 'u-3',
      type: 'en_route',
      // email toggled ON but email block missing a `to` — must be dropped.
      channels: { push: true, email: true, sms: true },
      push: { title: 'On the way!', body: 'Provider en route' },
      email: { subject: 'Hi' }, // no `to`
      sms: { body: 'On the way!' }, // no `to`
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: ['fcm'],
      }),
    );
  });

  it('returns null when every channel is either disabled or has no recipient', async () => {
    const { enqueueNotificationFromContext } = await import(
      '../utils/notifications-outbox'
    );

    const id = await enqueueNotificationFromContext({
      userId: 'u-4',
      type: 'reminder',
      channels: { push: false, email: false, sms: false },
      push: { title: 't', body: 'b' },
    });

    expect(id).toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('stores emailTemplateData as JSON string in payload.data when present', async () => {
    const { enqueueNotificationFromContext } = await import(
      '../utils/notifications-outbox'
    );

    await enqueueNotificationFromContext({
      userId: 'u-5',
      type: 'booking_confirmed',
      channels: { push: true, email: true, sms: false },
      push: { title: 'Confirmed', body: 'Your booking is confirmed' },
      email: {
        to: 'customer@example.com',
        subject: 'Booking Confirmed',
        templateId: 'tpl_booking',
        templateData: { customerName: 'Test', spaName: 'Luxe Spa', date: '2026-05-01' },
      },
    });

    const rowArg = mockSet.mock.calls[0][0];
    expect(rowArg.payload.data.emailTemplateId).toBe('tpl_booking');
    const parsed = JSON.parse(rowArg.payload.data.emailTemplateData);
    expect(parsed).toEqual({ customerName: 'Test', spaName: 'Luxe Spa', date: '2026-05-01' });
  });

  it('omits emailTemplateData key from payload.data when templateData is not provided', async () => {
    const { enqueueNotificationFromContext } = await import(
      '../utils/notifications-outbox'
    );

    await enqueueNotificationFromContext({
      userId: 'u-6',
      type: 'booking_cancelled',
      channels: { push: true, email: true, sms: false },
      push: { title: 'Cancelled', body: 'Booking cancelled' },
      email: { to: 'customer@example.com', subject: 'Cancelled', templateId: 'tpl_cancel' },
    });

    const rowArg = mockSet.mock.calls[0][0];
    expect(rowArg.payload.data.emailTemplateId).toBe('tpl_cancel');
    expect(rowArg.payload.data.emailTemplateData).toBeUndefined();
  });
});
