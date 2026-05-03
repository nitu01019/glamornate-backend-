import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { createLogger } from '../utils/logger';

const db = admin.firestore();
const logger = createLogger('onBookingCreated');

/**
 * Minimal zod schema covering only the fields this handler reads from the
 * booking doc. `.passthrough()` retains unknown fields so Firestore evolution
 * doesn't break parse. Malformed docs (missing required fields) are logged and
 * the handler exits early instead of crashing on `.field.foo` access.
 */
const BookingDocSchema = z
  .object({
    userId: z.string(),
    spaId: z.string(),
    bookingStatus: z.string().optional(),
    slot: z
      .object({
        date: z.string(),
        start: z.string(),
      })
      .passthrough()
      .optional(),
    serviceIds: z.array(z.string()).optional(),
    pricing: z.object({ total: z.number().optional() }).passthrough().optional(),
    therapistId: z.string().optional(),
    createdBy: z.string().optional(),
  })
  .passthrough();

/**
 * Triggered when a new booking is created
 * Sends notifications to customer and spa, creates audit log
 */
export const onBookingCreated = functions.firestore
  .document('bookings/{bookingId}')
  .onCreate(async (snap, context) => {
    const raw = snap.data();
    const { bookingId } = context.params;

    if (!raw) {
      logger.warn('Booking created trigger fired but snapshot data is null', { bookingId });
      return null;
    }

    const parsed = BookingDocSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error('[onBookingCreated] malformed booking doc', {
        bookingId,
        error: parsed.error.flatten(),
      });
      return null;
    }
    const booking = parsed.data;

    logger.info('Booking created', { bookingId, status: booking.bookingStatus });

    // Skip cancelled bookings
    if (booking.bookingStatus === 'cancelled') {
      return null;
    }

    // Guard against missing slot data
    if (!booking.slot || !booking.slot.date || !booking.slot.start) {
      logger.warn('Booking created but slot data is missing', { bookingId });
      return null;
    }

    const batch = db.batch();

    // 1. Get user details
    const userDoc = await db.collection('users').doc(booking.userId).get();
    const user = userDoc.data();

    // 2. Get spa details
    const spaDoc = await db.collection('spas').doc(booking.spaId).get();
    const spa = spaDoc.data();

    // 3. Create notification to customer
    const customerNotificationRef = db.collection('notifications').doc();
    batch.set(customerNotificationRef, {
      userId: booking.userId,
      type: 'booking_created',
      title: 'Booking Draft Created',
      body: `Your booking at ${spa?.name || 'the spa'} for ${booking.slot.date} at ${booking.slot.start} has been created.`,
      imageUrl: spa?.featuredImage,
      data: {
        bookingId,
        spaId: booking.spaId,
        type: 'booking',
      },
      read: false,
      channels: {
        push: true,
        email: user?.emailVerified || false,
        sms: false,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 4. Send notification to spa staff
    const spaOwnerId = spa?.ownerId;
    let staffIds: string[] = [];

    if (spaOwnerId) {
      staffIds.push(spaOwnerId);
    }

    // Add spa staff
    const staffSnapshot = await db
      .collection('users')
      .where('role', '==', 'spa_staff')
      .where('spaData.spaId', '==', booking.spaId)
      .where('isActive', '==', true)
      .get();

    staffSnapshot.forEach(doc => {
      staffIds.push(doc.id);
    });

    // Send notification to each staff member
    for (const staffId of [...new Set(staffIds)]) {
      const spaNotificationRef = db.collection('notifications').doc();
      batch.set(spaNotificationRef, {
        userId: staffId,
        type: 'new_booking',
        title: 'New Booking Draft Received',
        body: `New booking draft on ${booking.slot.date} at ${booking.slot.start} from ${user?.profile?.displayName || 'Customer'}`,
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

    // 5. Create audit log
    const auditLogRef = db.collection('audit_logs').doc();
    batch.set(auditLogRef, {
      userId: booking.userId,
      action: 'booking_created',
      entity: {
        type: 'booking',
        id: bookingId,
      },
      before: null,
      after: {
        bookingId,
        spaId: booking.spaId,
        slot: booking.slot,
        services: booking.serviceIds,
        total: booking.pricing?.total,
      },
      ipAddress: null, // Not available in triggers
      userAgent: null,
      metadata: {
        createdBy: booking.createdBy,
        therapistId: booking.therapistId,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    logger.info('Booking created notifications sent', { bookingId });

    return null;
  });
