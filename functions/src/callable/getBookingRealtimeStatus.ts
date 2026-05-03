import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

const GetBookingStatusSchema = z.object({
  bookingId: z.string(),
});

type GetBookingStatusInput = z.infer<typeof GetBookingStatusSchema>;

/**
 * Real-time booking status tracking
 *
 * This function polls the booking status and returns real-time updates.
 * It should be used in conjunction with Firestore onSnapshot listeners
 * for true real-time updates.
 */
export const getBookingRealtimeStatus = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'getBookingRealtimeStatus', windowMs: 60_000, max: 60 },
    async (data, context) => {
    // Validate authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Authentication required'
      );
    }

    const userId = context.auth.uid;

    try {
      const validated: GetBookingStatusInput = GetBookingStatusSchema.parse(data);

      // Get the booking
      const bookingDoc = await db.collection('bookings').doc(validated.bookingId).get();

      if (!bookingDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Booking not found');
      }

      const booking = bookingDoc.data()!;

      // Check if user has access to this booking
      const hasAccess =
        booking.userId === userId ||
        booking.spaId === userId || // Assuming spa owners use spaId as userId for this check
        booking.therapistId === userId;

      if (!hasAccess) {
        // Check if user is spa owner or staff
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data()!;
          const isSpaRelated =
            (userData.role === 'spa_owner' || userData.role === 'spa_staff') &&
            userData.spaData?.spaId === booking.spaId;

          if (!isSpaRelated) {
            throw new functions.https.HttpsError(
              'permission-denied',
              'Not authorized to view this booking'
            );
          }
        } else {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Not authorized to view this booking'
          );
        }
      }

      // Get related data for rich status
      const promises: Promise<any>[] = [];

      // Get spa details
      promises.push(
        db.collection('spas').doc(booking.spaId).get().then(doc => ({
          id: doc.id,
          ...doc.data(),
        })).catch(() => null)
      );

      // Get therapist details if applicable
      if (booking.therapistId) {
        promises.push(
          db.collection('therapists').doc(booking.therapistId).get().then(doc => ({
            id: doc.id,
            ...doc.data(),
          })).catch(() => null)
        );
      } else {
        promises.push(Promise.resolve(null));
      }

      // Get service details
      promises.push(
        Promise.all(
          booking.serviceIds.map((serviceId: string) =>
            db.collection('services').doc(serviceId).get().then(doc => ({
              id: doc.id,
              ...doc.data(),
            })).catch(() => null)
          )
        )
      );

      const [spa, therapist, services] = await Promise.all(promises);

      // Calculate time until appointment
      const scheduledTime = new Date(`${booking.slot.date}T${booking.slot.start}:00`);
      const now = new Date();
      const minutesUntil = Math.floor((scheduledTime.getTime() - now.getTime()) / (1000 * 60));

      let timeStatus: string;
      if (minutesUntil < 0) {
        timeStatus = scheduledTime.toISOString().split('T')[0] === now.toISOString().split('T')[0]
          ? 'today'
          : 'past';
      } else if (minutesUntil < 60) {
        timeStatus = 'soon';
      } else if (minutesUntil < 24 * 60) {
        timeStatus = 'today';
      } else if (minutesUntil < 48 * 60) {
        timeStatus = 'tomorrow';
      } else {
        timeStatus = 'future';
      }

      // Determine next expected status
      let nextExpectedStatus: string | null = null;
      let nextExpectedAction: string | null = null;

      // Post-Stripe pay-at-spa flow: bookings begin at 'confirmed'; the
      // legacy 'draft' / 'payment_pending' branches were removed because
      // customers never see a "Complete payment" prompt anymore.
      const statusFlow = [
        { current: 'confirmed', next: 'en_route', action: 'Awaiting appointment' },
        { current: 'en_route', next: 'in_progress', action: 'Service in progress' },
        { current: 'in_progress', next: 'completed', action: 'Complete service' },
      ];

      const currentFlow = statusFlow.find(f => f.current === booking.bookingStatus);
      if (currentFlow) {
        nextExpectedStatus = currentFlow.next;
        nextExpectedAction = currentFlow.action;
      }

      // Check in/out times
      const checkInTime = booking.checkIn
        ? booking.checkIn.toDate?.() || new Date(booking.checkIn)
        : null;
      const checkOutTime = booking.checkOut
        ? booking.checkOut.toDate?.() || new Date(booking.checkOut)
        : null;

      // Calculate service duration
      let elapsedTime: number | null = null;
      let remainingTime: number | null = null;

      if (checkInTime) {
        elapsedTime = Math.floor((now.getTime() - checkInTime.getTime()) / (1000 * 60));
      }

      if (booking.bookingStatus === 'in_progress' && elapsedTime !== null) {
        remainingTime = booking.slot.duration - elapsedTime;
        if (remainingTime < 0) remainingTime = 0;
      }

      return {
        success: true,
        booking: {
          id: bookingDoc.id,
          bookingStatus: booking.bookingStatus,
          statusHistory: booking.statusHistory,
          slot: booking.slot,
          pricing: booking.pricing,
          customer: booking.customer,
          reminderSent: booking.reminderSent,
          checkIn: checkInTime,
          checkOut: checkOutTime,
          scheduledAt: booking.scheduledAt,
          reviewId: booking.reviewId,
          createdAt: booking.createdAt,
          updatedAt: booking.updatedAt,
          // Phase 2 — surface location fields for spa-side detail view.
          // Conditional spread: legacy bookings without these fields stay
          // absent in the projection, and the strict
          // BookingCustomerLocationSchema.optional() parse on the consumer
          // side never sees a null/undefined that would fail.
          ...(booking.bookingLocation && { bookingLocation: booking.bookingLocation }),
          ...(booking.customerLocation && { customerLocation: booking.customerLocation }),
        },
        spa: spa ? {
          id: spa.id,
          name: spa.name,
          location: spa.location,
          contact: spa.contact,
          featuredImage: spa.featuredImage,
        } : null,
        therapist: therapist ? {
          id: therapist.id,
          name: therapist.name,
          displayName: therapist.displayName,
          photo: therapist.photo,
        } : null,
        services: (services || []).filter(Boolean),
        timeline: {
          scheduledTime: scheduledTime.toISOString(),
          timeUntil: minutesUntil,
          timeStatus,
        },
        progress: {
          elapsedTime,
          remainingTime,
          nextExpectedStatus,
          nextExpectedAction,
        },
      };

    } catch (error) {
      throw handleError(error);
    }
    },
  ),
);
