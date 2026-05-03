/**
 * Unit tests for notification templates — Phase 2 mandatory-location-capture.
 *
 * Asserts that the `bookingConfirmed` template renders the Maps deep-link
 * inside the SMS body for home-service bookings, AND that in-spa bookings
 * are unaffected (no SMS, no address injection).
 *
 * The template module imports firebase-admin transitively; that side-effect
 * is mocked out so this test runs in-process without an emulator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — keep firebase-admin / sgMail / logger inert so the template module
// loads without trying to bind a real Firestore instance.
// ---------------------------------------------------------------------------

vi.mock('firebase-admin', () => {
  const firestoreFn = () => ({ collection: vi.fn() });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (firestoreFn as any).FieldValue = { serverTimestamp: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (firestoreFn as any).Timestamp = {
    now: vi.fn(),
    fromDate: vi.fn(),
  };
  return {
    default: {
      firestore: firestoreFn,
      messaging: () => ({ sendEachForMulticast: vi.fn() }),
    },
    firestore: firestoreFn,
    messaging: () => ({ sendEachForMulticast: vi.fn() }),
  };
});

vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: vi.fn(), send: vi.fn() },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../service-config', () => ({
  isSendGridConfigured: () => false,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { notificationTemplates, type BookingSnapshot } from '../notifications';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function homeBooking(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    id: 'booking-123',
    userId: 'user-456',
    spaId: 'spa-789',
    slot: { date: '2026-05-01', start: '14:00', end: '15:00' },
    services: [{ serviceId: 'svc-1', name: 'Swedish Massage', price: 1500 }],
    customer: {
      email: 'customer@example.com',
      phone: '+919876543210',
    },
    pricing: { total: 1500, currency: 'INR' },
    bookingLocation: 'home',
    customerLocation: {
      coords: { lat: 12.97, lng: 77.59 },
      addressText: '42 MG Road, Bangalore',
      placeId: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
      additionalDetails: 'Ring doorbell twice',
    },
    ...overrides,
  };
}

function spaBooking(): BookingSnapshot {
  return {
    id: 'booking-spa-1',
    userId: 'user-456',
    spaId: 'spa-789',
    slot: { date: '2026-05-01', start: '14:00', end: '15:00' },
    services: [{ serviceId: 'svc-1', name: 'Swedish Massage', price: 1500 }],
    customer: { email: 'customer@example.com', phone: '+919876543210' },
    pricing: { total: 1500, currency: 'INR' },
    bookingLocation: 'spa',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notificationTemplates.bookingConfirmed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces an SMS body containing the Maps URL for home bookings', () => {
    const ctx = notificationTemplates.bookingConfirmed(
      homeBooking(),
      'Glamornate Spa'
    );

    expect(ctx.sms).toBeDefined();
    expect(ctx.sms?.to).toBe('+919876543210');
    // Wave 4.5 microcopy update (Booking Flow Fix v3.1, 2026-05-02): the
    // pay-at-spa SMS template carries the Maps directions URL + a
    // GLM-XXXXXX reference tail; the verbose address text was dropped from
    // the SMS body to fit the 160-char single-segment budget. Address
    // continues to appear in the email template data (asserted below).
    expect(ctx.sms?.body).toContain(
      'https://www.google.com/maps/dir/?api=1&destination='
    );
    expect(ctx.sms?.body).toContain('Pay at the spa');
    expect(ctx.sms?.body).toContain('Ref: GLM-');
    expect(ctx.sms?.body).toContain(
      'destination_place_id=ChIJbU60yXAWrjsR4E9-UejD3_g'
    );
  });

  it('flags channels.sms === true for home bookings', () => {
    const ctx = notificationTemplates.bookingConfirmed(
      homeBooking(),
      'Glamornate Spa'
    );
    expect(ctx.channels.sms).toBe(true);
  });

  it('injects sanitized address + mapsUrl + additionalDetails into email templateData', () => {
    const ctx = notificationTemplates.bookingConfirmed(
      homeBooking(),
      'Glamornate Spa'
    );

    expect(ctx.email?.templateData).toMatchObject({
      address: '42 MG Road, Bangalore',
      additionalDetails: 'Ring doorbell twice',
    });
    expect(String(ctx.email?.templateData?.mapsUrl)).toContain(
      'https://www.google.com/maps/dir/?api=1&destination=12.97,77.59'
    );
  });

  it('escapes HTML/quote characters in addressText via sanitizeInput()', () => {
    const ctx = notificationTemplates.bookingConfirmed(
      homeBooking({
        customerLocation: {
          coords: { lat: 12.97, lng: 77.59 },
          addressText: '<script>alert("xss")</script>',
          additionalDetails: 'O\'Reilly',
        },
      }),
      'Glamornate Spa'
    );

    // The sanitizer escapes <, >, ", and ' to HTML entities. The bare
    // '<script>' tag must not survive into the email templateData.
    // Wave 4.5 (Booking Flow Fix v3.1) — address text is no longer
    // injected into the SMS body, so the SMS-side escape assertion was
    // dropped; we only verify the email-side escape now.
    expect(String(ctx.email?.templateData?.address)).not.toContain('<script>');
    expect(String(ctx.email?.templateData?.address)).toContain('&lt;script&gt;');
    expect(String(ctx.email?.templateData?.additionalDetails)).toContain(
      'O&#x27;Reilly'
    );
  });

  it('omits SMS for in-spa bookings (channels.sms === false)', () => {
    const ctx = notificationTemplates.bookingConfirmed(
      spaBooking(),
      'Glamornate Spa'
    );
    expect(ctx.channels.sms).toBe(false);
    expect(ctx.sms).toBeUndefined();
  });

  it('falls back to in-spa rendering when bookingLocation is absent (legacy doc)', () => {
    const legacy = spaBooking();
    delete legacy.bookingLocation;
    const ctx = notificationTemplates.bookingConfirmed(legacy, 'Glamornate Spa');

    expect(ctx.channels.sms).toBe(false);
    expect(ctx.sms).toBeUndefined();
    expect(ctx.email?.templateData).not.toHaveProperty('mapsUrl');
    expect(ctx.email?.templateData).not.toHaveProperty('address');
  });

  it('omits SMS when home booking has no customer.phone (defensive)', () => {
    const ctx = notificationTemplates.bookingConfirmed(
      homeBooking({ customer: { email: 'a@b.c' } }),
      'Glamornate Spa'
    );
    // channels.sms is still true (template-level intent) but the payload
    // must not be set when there's no recipient.
    expect(ctx.sms).toBeUndefined();
  });
});
