import * as admin from 'firebase-admin';
import sgMail from '@sendgrid/mail';
import { createLogger } from './logger';
import { isSendGridConfigured } from './service-config';
import { sanitizeInput } from './validator';
import { buildMapsUrl } from './maps-url';

const db = admin.firestore();
const logger = createLogger('notifications');

// SMS via MSG91 Firebase Extension (msg91/msg91-send-msg) — writes to 'sms_dispatch' Firestore collection. See backend/functions/docs/SMS_ARCHITECTURE.md

// ---------------------------------------------------------------------------
// SendGrid lazy init
// ---------------------------------------------------------------------------
//
// `sgMail.setApiKey` mutates module-level state inside `@sendgrid/mail`. We
// guard the call so unit tests that load this module without `SENDGRID_API_KEY`
// in env don't crash at import time, and so we only call setApiKey once per
// runtime. Returns false when the helper should short-circuit (no key bound).

let sendGridInitialised = false;
function ensureSendGrid(): boolean {
  if (sendGridInitialised) return true;
  if (!isSendGridConfigured()) return false;
  sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
  sendGridInitialised = true;
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// FCM (Push Notifications)
// ============================================================================

export interface PushNotificationPayload {
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}

export interface NotificationChannels {
  push: boolean;
  email: boolean;
}

export async function sendPushNotification(
  userId: string,
  payload: PushNotificationPayload
): Promise<boolean> {
  try {
    // Get user's FCM tokens
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      logger.warn('User not found for push notification', { userId });
      return false;
    }

    const userData = userDoc.data();
    const fcmTokens = userData?.fcmTokens || [];

    if (fcmTokens.length === 0) {
      logger.warn('No FCM tokens found for user', { userId });
      return false;
    }

    // Create message
    const message: admin.messaging.MulticastMessage = {
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.imageUrl,
      },
      data: payload.data,
      android: {
        notification: {
          channelId: 'glamornate_bookings',
          priority: 'high',
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
      tokens: fcmTokens,
    };

    // Send multicast message
    const response = await admin.messaging().sendEachForMulticast(message);

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          if (
            resp.error?.code === 'messaging/registration-token-not-registered' ||
            resp.error?.code === 'messaging/invalid-registration-token'
          ) {
            invalidTokens.push(fcmTokens[idx]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        await userDoc.ref.update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
        });
        logger.info('Removed invalid FCM tokens', {
          userId,
          removedCount: invalidTokens.length,
        });
      }
    }

    logger.info('Push notification sent', {
      userId,
      successCount: response.successCount,
      totalDevices: fcmTokens.length,
    });

    return response.successCount > 0;
  } catch (error: unknown) {
    logger.error('Failed to send push notification', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// Email Notifications (SendGrid)
// ============================================================================
//
// Transactional email is sent via SendGrid v8 (`@sendgrid/mail`). The helper
// returns `true` when the provider responds with a 2xx status code and
// `false` on any provider error or missing configuration — the
// notifications-outbox worker uses that boolean to decide retry vs. drop.

export interface EmailNotificationPayload {
  to: string;
  subject: string;
  templateId?: string;
  templateData?: Record<string, unknown>;
  html?: string;
  from?: string;
}

export async function sendEmailNotification(
  payload: EmailNotificationPayload
): Promise<boolean> {
  if (!ensureSendGrid()) {
    logger.warn('SendGrid not configured — email not dispatched', {
      to: payload.to,
      subject: payload.subject,
    });
    return false;
  }

  const fromEmail = process.env.SENDGRID_FROM_EMAIL!;
  const fromName = process.env.SENDGRID_FROM_NAME ?? 'Glamornate';
  const html = payload.html ?? `<p>${escapeHtml(payload.subject)}</p>`;

  type MsgShape = {
    to: string;
    from: { email: string; name: string };
    subject: string;
    html?: string;
    templateId?: string;
    dynamicTemplateData?: Record<string, unknown>;
  };

  const msg: MsgShape = {
    to: payload.to,
    from: payload.from
      ? { email: payload.from, name: fromName }
      : { email: fromEmail, name: fromName },
    subject: payload.subject,
    html,
  };

  if (payload.templateId) {
    msg.templateId = payload.templateId;
    msg.dynamicTemplateData = payload.templateData ?? {};
    // SendGrid ignores `html` when `templateId` is set; remove it for clarity.
    delete msg.html;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [response] = await sgMail.send(msg as any);
    const statusCode = response?.statusCode ?? 0;
    const ok = statusCode >= 200 && statusCode < 300;
    if (!ok) {
      logger.warn('SendGrid returned non-2xx status', {
        to: payload.to,
        subject: payload.subject,
        statusCode,
      });
    } else {
      logger.info('Email dispatched via SendGrid', {
        to: payload.to,
        subject: payload.subject,
        statusCode,
      });
    }
    return ok;
  } catch (error: unknown) {
    logger.error('SendGrid send failed', {
      to: payload.to,
      subject: payload.subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// SMS Notifications (MSG91 Firebase Extension)
// ============================================================================
//
// `sendSmsNotification` writes a document to the `sms_dispatch` Firestore
// collection watched by the MSG91 Firebase Extension. The extension's Cloud
// Function picks up the document and calls the MSG91 SMS API. No npm HTTP
// client needed — `firebase-admin` is the only dependency.

const SMS_DISPATCH_COLLECTION =
  process.env.MSG91_COLLECTION_NAME ?? 'sms_dispatch';

export interface SmsPayload {
  to: string;   // E.164 format: "+919876543210"
  body: string; // Max 160 chars for a single SMS segment
}

export async function sendSmsNotification(
  payload: SmsPayload,
  firestoreDb: FirebaseFirestore.Firestore = db,
): Promise<boolean> {
  if (!payload.to || !payload.body) {
    logger.warn('sendSmsNotification: missing to or body — skipping', {
      to: payload.to,
    });
    return false;
  }

  try {
    const ref = firestoreDb.collection(SMS_DISPATCH_COLLECTION).doc();
    await ref.set({
      to: payload.to,
      message: payload.body,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info('SMS enqueued to dispatch collection', {
      to: payload.to,
      docId: ref.id,
      collection: SMS_DISPATCH_COLLECTION,
    });
    return true;
  } catch (error: unknown) {
    logger.error('SMS dispatch write failed', {
      to: payload.to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// Unified Notification Service
// ============================================================================

export interface NotificationContext {
  userId: string;
  type: string;
  channels: NotificationChannels & { sms?: boolean };
  push: PushNotificationPayload;
  email?: EmailNotificationPayload;
  /**
   * Phase 2 — optional SMS payload, currently consumed by
   * `enqueueNotificationFromContext` (notifications-outbox) which dispatches
   * via the MSG91 Firebase Extension. `sendMultiChannelNotification` itself
   * does NOT dispatch SMS — it ignores the field — so adding it here is a
   * type-only widening that lets the bookingConfirmed template carry the
   * Maps URL into the outbox writer.
   */
  sms?: { to: string; body: string };
  metadata?: Record<string, unknown>;
}

export async function sendMultiChannelNotification(
  context: NotificationContext
): Promise<{ push: boolean; email: boolean }> {
  const results = { push: false, email: false };

  logger.info('Sending multi-channel notification', {
    userId: context.userId,
    type: context.type,
    channels: context.channels,
  });

  try {
    const promises: Promise<void>[] = [];

    // Push notification (always available via FCM)
    if (context.channels.push) {
      promises.push(
        sendPushNotification(context.userId, context.push)
          .then(r => {
            results.push = r;
          })
          .catch((err: unknown) => {
            logger.error('Push notification failed', { userId: context.userId, error: err instanceof Error ? err.message : String(err) });
            results.push = false;
          })
      );
    }

    // Email channel via SendGrid
    if (context.channels.email && context.email) {
      promises.push(
        sendEmailNotification(context.email)
          .then(r => {
            results.email = r;
          })
          .catch((err: unknown) => {
            logger.error('Email notification failed', { to: context.email?.to, error: err instanceof Error ? err.message : String(err) });
            results.email = false;
          })
      );
    }

    await Promise.all(promises);

    // Create notification record in Firestore
    await db.collection('notifications').add({
      userId: context.userId,
      type: context.type,
      title: context.push.title,
      body: context.push.body,
      imageUrl: context.push.imageUrl,
      data: { ...context.push.data, ...context.metadata },
      read: false,
      readAt: null,
      deliveryStatus: results.push ? 'delivered' : 'failed',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      channels: {
        push: results.push,
        email: results.email,
      },
      serviceStatus: {
        emailEnabled: isSendGridConfigured(),
      },
    });

    logger.info('Multi-channel notification completed', {
      userId: context.userId,
      type: context.type,
      results,
    });
  } catch (error: unknown) {
    logger.error('Error in multi-channel notification', {
      userId: context.userId,
      type: context.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return results;
}

// ============================================================================
// FCM Token Management
// ============================================================================

export async function registerFCMToken(
  userId: string,
  token: string,
  deviceInfo?: {
    platform: 'web' | 'ios' | 'android';
    deviceName?: string;
  }
): Promise<void> {
  const userDoc = await db.collection('users').doc(userId).get();

  if (!userDoc.exists) {
    throw new Error('User not found');
  }

  const userData = userDoc.data();
  const fcmTokens = userData?.fcmTokens || [];

  if (!fcmTokens.includes(token)) {
    await userDoc.ref.update({
      fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
      ...(deviceInfo && {
        deviceInfo: {
          [token]: deviceInfo,
        },
      }),
    });
  }
}

export async function unregisterFCMToken(
  userId: string,
  token: string
): Promise<void> {
  const userDoc = await db.collection('users').doc(userId).get();

  if (!userDoc.exists) {
    throw new Error('User not found');
  }

  await userDoc.ref.update({
    fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
  });
}

// ============================================================================
// Notification Templates
// ============================================================================

/** Minimal booking shape used by notification templates */
export interface BookingSnapshot {
  id: string;
  userId: string;
  spaId: string;
  therapistId?: string;
  slot: { date: string; start: string; end: string };
  services: Array<{ serviceId: string; name?: string; price: number }>;
  customer?: { email?: string; phone?: string };
  pricing?: { total: number; currency: string };
  /**
   * Phase 2 mandatory-location-capture fields. Optional on this shape
   * because legacy bookings predating Phase 2 have neither field; the
   * templates short-circuit to the in-spa render path when bookingLocation
   * is absent (legacy default) or === 'spa'.
   */
  bookingLocation?: 'spa' | 'home';
  customerLocation?: {
    coords: { lat: number; lng: number };
    addressText: string;
    placeId?: string;
    additionalDetails?: string;
  };
}

export const notificationTemplates = {
  bookingConfirmed: (
    booking: BookingSnapshot,
    spaName: string
  ): NotificationContext => {
    // Phase 2 — for home-service bookings, inject sanitized address +
    // Maps deep-link into the email template data and an SMS body.
    // sanitizeInput() guards against XSS / SMS-spoof injection in the
    // address text and additionalDetails fields (both ultimately user-
    // controlled via the customer wizard).
    const isHome =
      booking.bookingLocation === 'home' && !!booking.customerLocation;
    const safeAddress = isHome
      ? sanitizeInput(booking.customerLocation!.addressText)
      : '';
    const rawDetails = booking.customerLocation?.additionalDetails ?? '';
    const safeDetails = isHome && rawDetails ? sanitizeInput(rawDetails) : '';
    const mapsUrl = isHome ? buildMapsUrl(booking.customerLocation!) : '';

    const baseTemplateData: Record<string, unknown> = {
      spaName,
      date: booking.slot.date,
      time: booking.slot.start,
      services: booking.services.map((s) => s.name || s.serviceId).join(', '),
    };

    const ctx: NotificationContext = {
      userId: booking.userId,
      type: 'booking_confirmed',
      channels: { push: true, email: true, sms: isHome },
      push: {
        // Phase 4.5 (Booking Flow Fix v3.1, 2026-05-02): sentence-case
        // microcopy mandate. Confirms the appointment AND tells the
        // customer where to pay so the pay-at-spa mental model lands.
        title: 'Booking confirmed',
        body: isHome
          ? `Your home-service appointment is confirmed for ${booking.slot.date} at ${booking.slot.start}. Pay on arrival. Address: ${safeAddress}`
          : `${booking.slot.start} at ${spaName}. Pay at the spa on arrival.`,
        data: {
          bookingId: booking.id,
          type: 'booking_confirmed',
        },
      },
      email: {
        to: booking.customer?.email || '',
        subject: 'Booking confirmed — Glamornate',
        templateData: isHome
          ? {
              ...baseTemplateData,
              address: safeAddress,
              mapsUrl,
              additionalDetails: safeDetails,
            }
          : baseTemplateData,
      },
    };

    if (isHome && booking.customer?.phone) {
      // Phase 4.5 SMS template: include the pay-at-spa cue + bookingId
      // tail for self-service identification when customers reply.
      const refTail = booking.id.slice(-6).toUpperCase();
      ctx.sms = {
        to: booking.customer.phone,
        body: `Glamornate: Booking confirmed for ${booking.slot.date} at ${booking.slot.start}. Pay at the spa. Ref: GLM-${refTail}. ${mapsUrl}`,
      };
    }

    return ctx;
  },

  bookingCancelled: (
    booking: BookingSnapshot,
    reason: string
  ): NotificationContext => ({
    userId: booking.userId,
    type: 'booking_cancelled',
    channels: { push: true, email: true },
    push: {
      title: 'Booking Cancelled',
      body: reason || 'Your booking has been cancelled',
      data: {
        bookingId: booking.id,
        type: 'booking_cancelled',
      },
    },
    email: {
      to: booking.customer?.email || '',
      subject: 'Booking Cancelled - Glamornate',
      templateData: {
        reason,
      },
    },
  }),

  bookingReminder: (
    booking: BookingSnapshot,
    spaName: string,
    hoursBefore: number
  ): NotificationContext => ({
    userId: booking.userId,
    type: 'booking_reminder',
    channels: { push: true, email: false },
    push: {
      title: hoursBefore === 24 ? 'See you tomorrow!' : 'Your appointment is coming up!',
      body: `Your appointment at ${spaName} is ${hoursBefore} hours away`,
      data: {
        bookingId: booking.id,
        type: 'booking_reminder',
      },
    },
  }),

  reviewReminder: (booking: BookingSnapshot, spaName: string): NotificationContext => ({
    userId: booking.userId,
    type: 'review_reminder',
    channels: { push: true, email: false },
    push: {
      title: 'How was your experience?',
      body: `Rate your recent experience at ${spaName}`,
      data: {
        bookingId: booking.id,
        type: 'review_reminder',
      },
    },
  }),

  spaVerified: (spaId: string, userId: string): NotificationContext => ({
    userId,
    type: 'spa_verified',
    // M-NOTIFY-T-04: email removed — `to: ''` was unreachable (no address at template
    // construction time). Email for spa-verified flows must be dispatched by the caller
    // once the user email is resolved from Firestore.
    channels: { push: true, email: false },
    push: {
      title: 'Spa Verified!',
      body: 'Congratulations! Your spa has been verified and is now live on Glamornate',
      data: {
        spaId,
        type: 'spa_verified',
      },
    },
  }),

  newBooking: (booking: BookingSnapshot, customerName: string): NotificationContext => ({
    userId: booking.spaId, // This will be resolved to spa owner/user
    type: 'new_booking',
    // M-NOTIFY-T-04: email flag corrected to false — no email payload was ever
    // constructed in this template, so channels.email: true was a dead flag.
    channels: { push: true, email: false },
    push: {
      title: 'New Booking!',
      body: `${customerName} has booked an appointment`,
      data: {
        bookingId: booking.id,
        type: 'new_booking',
      },
    },
  }),
};
