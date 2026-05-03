import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { enqueueNotificationFromContext } from '../utils/notifications-outbox';
import { triggerBookingUpdate } from '../utils/realtime-tracking';
import { sanitizeInput } from '../utils/validator';
import { buildMapsUrl } from '../utils/maps-url';

const db = admin.firestore();

// TTL for processed-event sentinel documents (7 days in seconds)
const PROCESSED_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Minimal zod schema covering only the fields this handler reads from the
 * booking doc across all status transitions (confirmed, en_route, in_progress,
 * completed, cancelled). `.passthrough()` retains unknown fields so existing
 * docs and future evolution don't break parse. Malformed docs are logged and
 * the handler exits early instead of crashing on `.field.foo` access in
 * downstream notification/analytics writes.
 */
const BookingDocSchema = z
  .object({
    bookingStatus: z.string().optional(),
    userId: z.string().optional(),
    spaId: z.string().optional(),
    slot: z
      .object({
        date: z.string().optional(),
        start: z.string().optional(),
      })
      .passthrough()
      .optional(),
    customer: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
      })
      .passthrough()
      .optional(),
    services: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    pricing: z.object({ total: z.number().optional() }).passthrough().optional(),
    cancellation: z
      .object({
        reason: z.string().optional(),
        cancelledBy: z.string().optional(),
        refundedAmount: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Triggered when booking status changes.
 * This is the SINGLE handler for all booking status transitions.
 *
 * Idempotency: writes a sentinel doc to _processedEvents/{eventId} inside a
 * transaction before doing any work. If the event was already handled the
 * function exits early, preventing duplicate side-effects from Cloud Functions
 * at-least-once delivery.
 *
 * Consolidates all logic previously split across onBookingConfirmed.ts and
 * this file. onBookingConfirmed.ts has been removed.
 */
export const onBookingStatusChanged = functions.firestore
  .document('bookings/{bookingId}')
  .onUpdate(async (change, context) => {
    const rawBefore = change.before.data();
    const rawAfter = change.after.data();
    const bookingId = context.params.bookingId;
    const eventId = context.eventId;

    if (!rawBefore || !rawAfter) {
      functions.logger.warn('Booking status change fired with null snapshot data', {
        bookingId,
        eventId,
      });
      return null;
    }

    const beforeParsed = BookingDocSchema.safeParse(rawBefore);
    const afterParsed = BookingDocSchema.safeParse(rawAfter);
    if (!beforeParsed.success || !afterParsed.success) {
      functions.logger.error('[onBookingStatusChanged] malformed booking doc', {
        bookingId,
        eventId,
        beforeError: beforeParsed.success ? null : beforeParsed.error.flatten(),
        afterError: afterParsed.success ? null : afterParsed.error.flatten(),
      });
      return null;
    }
    const before = beforeParsed.data;
    const after = afterParsed.data;

    // Only proceed if status actually changed
    if (before.bookingStatus === after.bookingStatus) {
      return null;
    }

    // --- Idempotency guard ---
    const sentinelRef = db.collection('_processedEvents').doc(eventId);
    const alreadyProcessed = await db.runTransaction(async (transaction) => {
      const sentinelSnap = await transaction.get(sentinelRef);
      if (sentinelSnap.exists) {
        return true;
      }
      transaction.set(sentinelRef, {
        eventId,
        bookingId,
        fromStatus: before.bookingStatus,
        toStatus: after.bookingStatus,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        // expiresAt is used by a TTL policy on the _processedEvents collection
        expiresAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + PROCESSED_EVENT_TTL_SECONDS * 1000)
        ),
      });
      return false;
    });

    if (alreadyProcessed) {
      functions.logger.info('Duplicate event detected, skipping', { eventId, bookingId });
      return null;
    }
    // --- End idempotency guard ---

    const fromStatus = before.bookingStatus;
    const toStatus = after.bookingStatus;

    functions.logger.info('Booking status changed', {
      bookingId,
      from: fromStatus,
      to: toStatus,
      eventId,
    });

    // Trigger real-time update for all connected clients
    await triggerBookingUpdate(bookingId, 'status', fromStatus, toStatus);

    // Handle specific status transitions
    switch (toStatus) {
      case 'confirmed':
        await handleBookingConfirmed(bookingId, after, change.after);
        break;

      case 'en_route':
        await handleEnRoute(after, change.after);
        break;

      case 'in_progress':
        await handleInProgress(after, change.after);
        break;

      case 'completed':
        await handleCompleted(after, change.after);
        break;

      case 'cancelled':
        await handleCancelled(after, change.before);
        break;
    }

    return null;
  });

/**
 * Handles all side-effects when a booking transitions to 'confirmed'.
 * Previously split between onBookingConfirmed.ts (notifications, reminders,
 * analytics) and this file (staff notifications). Now fully consolidated here.
 */
async function handleBookingConfirmed(
  bookingId: string,
  booking: FirebaseFirestore.DocumentData,
  docRef: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  // Guard against missing required data
  if (!booking.userId || !booking.spaId) {
    functions.logger.warn('Booking confirmed but userId or spaId is missing', { bookingId });
    return;
  }

  if (!booking.slot?.date || !booking.slot?.start) {
    functions.logger.warn('Booking confirmed but slot data is missing', { bookingId });
    return;
  }

  // Get user and spa details in parallel
  const [userDoc, spaDoc] = await Promise.all([
    db.collection('users').doc(booking.userId).get(),
    db.collection('spas').doc(booking.spaId).get(),
  ]);

  const user = userDoc.data();
  const spa = spaDoc.data();

  // Phase 2 — pre-compute the sanitized address + Maps URL once for reuse
  // in both the customer notification body and (below) the staff email
  // templateData. sanitizeInput() guards against XSS / SMS-spoof injection
  // in the user-controlled addressText / additionalDetails fields.
  const isHome =
    booking.bookingLocation === 'home' && !!booking.customerLocation;
  const safeAddress = isHome
    ? sanitizeInput(String(booking.customerLocation.addressText ?? ''))
    : '';
  const safeDetails =
    isHome && booking.customerLocation.additionalDetails
      ? sanitizeInput(String(booking.customerLocation.additionalDetails))
      : '';
  const mapsUrl = isHome ? buildMapsUrl(booking.customerLocation) : '';

  const batch = db.batch();

  // 1. Send confirmation notification to customer
  const customerNotificationRef = db.collection('notifications').doc();
  batch.set(customerNotificationRef, {
    userId: booking.userId,
    type: 'booking_confirmed',
    // Phase 4.5 microcopy mandate (Booking Flow Fix v3.1, 2026-05-02):
    // sentence-case 'Booking confirmed' everywhere; body now mentions
    // pay-at-spa so the customer's mental model lines up with the
    // post-Stripe pricing surface.
    title: 'Booking confirmed',
    body: isHome
      ? `Your home-service appointment on ${booking.slot.date} at ${booking.slot.start} is confirmed. Pay on arrival. Address: ${safeAddress}`
      : `${booking.slot.start} at ${spa?.name || 'the spa'}. Pay at the spa on arrival.`,
    imageUrl: spa?.featuredImage,
    data: {
      bookingId,
      spaId: booking.spaId,
      type: 'booking',
    },
    read: false,
    channels: {
      push: true,
      email: user?.emailVerified || true,
      sms: user?.phoneVerified || false,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2. Send notification to spa owner
  if (spa?.ownerId) {
    const spaOwnerNotificationRef = db.collection('notifications').doc();
    batch.set(spaOwnerNotificationRef, {
      userId: spa.ownerId,
      type: 'booking_confirmed_spa',
      title: 'Booking Confirmed',
      body: `Booking confirmed for ${booking.slot.date} at ${booking.slot.start}. Customer: ${user?.profile?.displayName || 'Customer'}`,
      data: {
        bookingId,
        userId: booking.userId,
        type: 'booking_management',
      },
      read: false,
      channels: { push: true, email: true, sms: false },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();

  // 3. Notify all active spa staff via multi-channel
  const spaStaffQuery = await db
    .collection('users')
    .where('spaData.spaId', '==', booking.spaId)
    .where('isActive', '==', true)
    .where('role', 'in', ['spa_owner', 'spa_staff'])
    .get();

  for (const staffDoc of spaStaffQuery.docs) {
    await enqueueNotificationFromContext({
      userId: staffDoc.id,
      type: 'new_booking',
      channels: { push: true, email: true, sms: false },
      push: {
        title: 'New Booking!',
        body: `New appointment for ${booking.slot.date} at ${booking.slot.start}`,
        data: { bookingId, type: 'new_booking' },
      },
      email: {
        to: staffDoc.data().profile?.email || '',
        subject: 'New Booking - Glamornate',
        templateId: process.env.SENDGRID_TEMPLATE_NEW_BOOKING,
        templateData: {
          customerName: booking.customer?.name,
          date: booking.slot.date,
          time: booking.slot.start,
          services: booking.services?.map((s: { name: string }) => s.name).join(', '),
          // Phase 2 — surface address + Maps URL on home-service bookings
          // for the technician/spa-staff email template. Conditional fields
          // remain undefined for in-spa bookings; SendGrid templates must
          // gate rendering on `{{#if address}}` accordingly.
          ...(isHome && {
            bookingLocation: 'home',
            address: safeAddress,
            mapsUrl,
            additionalDetails: safeDetails,
          }),
        },
      },
    });
  }

  // 4. Schedule 24-hour reminder
  const scheduledDate = new Date(booking.slot.date);
  const [hours, minutes] = booking.slot.start.split(':').map(Number);
  scheduledDate.setHours(hours, minutes, 0, 0);

  const reminder24h = new Date(scheduledDate.getTime() - 24 * 60 * 60 * 1000);
  if (reminder24h > new Date()) {
    await scheduleReminder(bookingId, '24hr', reminder24h, booking);
  }

  // 5. Schedule 2-hour reminder
  const reminder2h = new Date(scheduledDate.getTime() - 2 * 60 * 60 * 1000);
  if (reminder2h > new Date()) {
    await scheduleReminder(bookingId, '2hr', reminder2h, booking);
  }

  // 6. Log analytics
  await db.collection('analytics').add({
    type: 'booking_confirmed',
    bookingId,
    spaId: booking.spaId,
    userId: booking.userId,
    amount: booking.pricing?.total || 0,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  functions.logger.info('Booking confirmed: notifications, reminders, and analytics recorded', {
    bookingId,
  });
}

async function handleEnRoute(booking: FirebaseFirestore.DocumentData, docRef: FirebaseFirestore.DocumentSnapshot): Promise<void> {
  // Phase 2 — for home-service bookings, inject the sanitized address and a
  // Maps deep-link into the SMS body so the technician (when this template
  // is repurposed for technician-facing SMS) and customer both have one-tap
  // navigation to the doorstep. sanitizeInput() guards against XSS / SMS-
  // spoof injection in user-controlled address text.
  const isHome =
    booking.bookingLocation === 'home' && !!booking.customerLocation;
  const safeAddress = isHome
    ? sanitizeInput(String(booking.customerLocation.addressText ?? ''))
    : '';
  const mapsUrl = isHome ? buildMapsUrl(booking.customerLocation) : '';

  const smsBody = isHome
    ? `Your therapist is en route to ${safeAddress}. ${mapsUrl}`
    : 'Your therapist is en route. Please be ready for your appointment.';

  await enqueueNotificationFromContext({
    userId: booking.userId,
    type: 'en_route',
    channels: { push: true, sms: true, email: false },
    push: {
      title: 'On the way!',
      body: 'Your service provider is on the way to your appointment',
      data: { bookingId: docRef.id, type: 'en_route' },
    },
    sms: {
      to: booking.customer?.phone,
      body: smsBody,
    },
  });

  functions.logger.info('En route notification enqueued', { bookingId: docRef.id });
}

async function handleInProgress(booking: FirebaseFirestore.DocumentData, docRef: FirebaseFirestore.DocumentSnapshot): Promise<void> {
  await enqueueNotificationFromContext({
    userId: booking.userId,
    type: 'in_progress',
    channels: { push: true, sms: false, email: false },
    push: {
      title: 'Service Started',
      body: 'Your appointment has begun. Relax and enjoy!',
      data: { bookingId: docRef.id, type: 'in_progress' },
    },
  });

  functions.logger.info('In progress notification enqueued', { bookingId: docRef.id });
}

async function handleCompleted(booking: FirebaseFirestore.DocumentData, docRef: FirebaseFirestore.DocumentSnapshot): Promise<void> {
  await enqueueNotificationFromContext({
    userId: booking.userId,
    type: 'completed',
    channels: { push: true, email: true, sms: false },
    push: {
      title: 'Appointment Complete',
      body: 'Thank you for choosing Glamornate! Please leave a review.',
      data: { bookingId: docRef.id, type: 'completed' },
    },
    email: {
      to: booking.customer?.email,
      subject: 'How was your experience? - Glamornate',
      templateId: process.env.SENDGRID_TEMPLATE_REVIEW_REQUEST,
      templateData: {
        bookingId: docRef.id,
      },
    },
  });

  // Schedule review reminder notification after 24 hours
  const reviewReminderTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.collection('scheduled_notifications').add({
    userId: booking.userId,
    bookingId: docRef.id,
    type: 'review_reminder',
    scheduledFor: admin.firestore.Timestamp.fromDate(reviewReminderTime),
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  functions.logger.info('Completed notifications enqueued', { bookingId: docRef.id });
}

async function handleCancelled(booking: FirebaseFirestore.DocumentData, docRef: FirebaseFirestore.DocumentSnapshot): Promise<void> {
  const reason = booking.cancellation?.reason || 'Booking cancelled';
  const cancelledBy = booking.cancellation?.cancelledBy || 'system';
  const hasRefund = (booking.cancellation?.refundedAmount ?? 0) > 0;

  const cancellationPushBody = hasRefund
    ? `Your booking has been cancelled. Refund of ₹${booking.cancellation.refundedAmount} will be processed.`
    : `Your booking has been cancelled. ${reason}`;

  await enqueueNotificationFromContext({
    userId: booking.userId,
    type: 'booking_cancelled',
    channels: { push: true, email: true, sms: true },
    push: {
      title: 'Booking Cancelled',
      body: cancellationPushBody,
      data: { bookingId: docRef.id, type: 'booking_cancelled' },
    },
    email: {
      to: booking.customer?.email,
      subject: 'Booking Cancelled - Glamornate',
      templateId: process.env.SENDGRID_TEMPLATE_BOOKING_CANCELLED,
      templateData: {
        reason,
        refundAmount: booking.cancellation?.refundedAmount,
        hasRefund,
      },
    },
    sms: {
      to: booking.customer?.phone,
      body: hasRefund
        ? `Your Glamornate booking has been cancelled. A refund of ₹${booking.cancellation.refundedAmount} will be processed.`
        : `Your Glamornate booking has been cancelled. ${reason}`,
    },
  });

  if (cancelledBy === 'customer') {
    const spaStaffQuery = await db
      .collection('users')
      .where('spaData.spaId', '==', booking.spaId)
      .where('isActive', '==', true)
      .where('role', 'in', ['spa_owner', 'spa_staff'])
      .get();

    for (const staffDoc of spaStaffQuery.docs) {
      await enqueueNotificationFromContext({
        userId: staffDoc.id,
        type: 'booking_cancelled',
        channels: { push: true, email: true, sms: false },
        push: {
          title: 'Booking Cancelled by Customer',
          body: `Appointment at ${booking.slot?.date} ${booking.slot?.start} has been cancelled`,
          data: { bookingId: docRef.id, type: 'booking_cancelled' },
        },
      });
    }
  }

  functions.logger.info('Cancelled notifications enqueued', {
    bookingId: docRef.id,
    cancelledBy,
  });
}

async function scheduleReminder(
  bookingId: string,
  type: '24hr' | '2hr',
  scheduledTime: Date,
  booking: FirebaseFirestore.DocumentData
): Promise<void> {
  await db.collection('scheduled_reminders').add({
    bookingId,
    type,
    scheduledAt: admin.firestore.Timestamp.fromDate(scheduledTime),
    status: 'pending',
    booking,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  functions.logger.info('Reminder scheduled', { bookingId, type, scheduledTime });
}
