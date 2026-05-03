import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { BOOKING_HOLD_DURATION_SECONDS } from './constants';

const db = admin.firestore();

// ============================================================================
// Internal Document Shapes
// ============================================================================

/** Booking.services[i] minimal shape used here. */
interface BookingServiceLine {
  serviceId: string;
  name?: string;
}

/** Availability slot shape stored in `availability/<id>.slots[]`. */
interface AvailabilitySlot {
  start: string;
  end: string;
  bookingId?: string | null;
  available?: boolean;
  heldUntil?: admin.firestore.Timestamp | null;
  duration?: number;
}

/** Booking doc shape (loose — only fields read in this module). */
interface BookingDocLite {
  bookingStatus?: string;
  services?: BookingServiceLine[];
  serviceProgress?: ServiceProgress[];
  slot?: { date: string; start: string; end: string };
  spaId?: string;
  therapistId?: string;
  userId?: string;
  location?: LocationUpdate | null;
  checkIn?: { at?: admin.firestore.Timestamp } | null;
  createdAt?: admin.firestore.Timestamp;
  [key: string]: unknown;
}

/** Realtime update payload written to `realtime_updates/<id>`. */
type RealtimeUpdatePayload = Record<string, unknown>;

// ============================================================================
// Real-time Booking Tracking Utilities
// ============================================================================

/**
 * Triggers real-time updates for a booking
 * This function creates a notification record and can trigger
 * push notifications to all parties involved in the booking
 */
export async function triggerBookingUpdate(
  bookingId: string,
  updateType: 'status' | 'slot' | 'therapist' | 'service',
  previousData?: unknown,
  newData?: unknown
): Promise<void> {
  const bookingDoc = await db.collection('bookings').doc(bookingId).get();
  if (!bookingDoc.exists) {
    functions.logger.warn(`Booking ${bookingId} not found for realtime update`);
    return;
  }

  const booking = bookingDoc.data()!;

  // Get spa owner/staff users to notify
  const spaUsersQuery = await db
    .collection('users')
    .where('spaData.spaId', '==', booking.spaId)
    .where('isActive', '==', true)
    .get();

  const userIdsToNotify = [booking.userId, ...spaUsersQuery.docs.map(doc => doc.id)];

  // Create realtime update events for all connected clients
  for (const userId of userIdsToNotify) {
    await db.collection('realtime_updates').doc(`${userId}_${bookingId}`).set({
      userId,
      bookingId,
      updateType,
      previousData,
      newData,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
      ),
    });
  }

  functions.logger.info(`Real-time update triggered for booking ${bookingId}`, {
    updateType,
    notifiedUsers: userIdsToNotify,
  });
}

/**
 * Subscribes a client to real-time updates for a booking
 */
export function subscribeToBookingUpdates(
  bookingId: string,
  userId: string,
  onUpdate: (update: RealtimeUpdatePayload) => void
): () => void {
  const docId = `${userId}_${bookingId}`;
  const unsubscribe = db
    .collection('realtime_updates')
    .doc(docId)
    .onSnapshot(
      (snapshot) => {
        if (snapshot.exists) {
          const data = snapshot.data() as RealtimeUpdatePayload | undefined;
          if (data) {
            onUpdate(data);
          }
        }
      },
      (error) => {
        functions.logger.error('Error subscribing to booking updates', { error, bookingId, userId });
      }
    );

  return unsubscribe;
}

// ============================================================================
// Booking Status State Machine
// ============================================================================

// Post-Stripe pay-at-spa state machine — closed 6-state set.
// Bookings are created directly in 'confirmed' (no payment_pending phase).
export const BookingStatusTransitions: Record<string, string[]> = {
  confirmed: ['en_route', 'in_progress', 'cancelled', 'no_show'],
  en_route: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [], // Terminal state
  cancelled: [], // Terminal state
  no_show: [], // Terminal state
};

export function canTransition(from: string, to: string): boolean {
  const allowedTransitions = BookingStatusTransitions[from] || [];
  return allowedTransitions.includes(to);
}

export async function transitionBookingStatus(
  bookingId: string,
  newStatus: string,
  actor: 'customer' | 'spa' | 'admin' | 'system',
  actorId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingDoc.data()!;
    const currentStatus = booking.bookingStatus;

    // Validate transition
    if (!canTransition(currentStatus, newStatus)) {
      return {
        success: false,
        error: `Cannot transition from ${currentStatus} to ${newStatus}`,
      };
    }

    // Create status history entry
    const historyEntry = {
      status: newStatus,
      from: currentStatus,
      to: newStatus,
      actor,
      actorId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      reason,
    };

    // Update booking
    await bookingRef.update({
      bookingStatus: newStatus,
      statusHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Trigger real-time update
    await triggerBookingUpdate(bookingId, 'status', currentStatus, newStatus);

    functions.logger.info(`Booking status transitioned`, {
      bookingId,
      from: currentStatus,
      to: newStatus,
      actor,
    });

    return { success: true };
  } catch (error) {
    functions.logger.error('Error transitioning booking status', { error, bookingId });
    return { success: false, error: 'Internal error' };
  }
}

// ============================================================================
// Location Tracking for En-Route Bookings
// ============================================================================

export interface LocationUpdate {
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  accuracy?: number;
  timestamp: number;
}

/**
 * Update therapist/vehicle location for en-route bookings
 */
export async function updateBookingLocation(
  bookingId: string,
  location: LocationUpdate,
  therapistId: string
): Promise<void> {
  const bookingDoc = await db.collection('bookings').doc(bookingId).get();
  if (!bookingDoc.exists) {
    functions.logger.warn(`Booking ${bookingId} not found for location update`);
    return;
  }

  const booking = bookingDoc.data()!;

  // Verify therapist ID matches
  if (booking.therapistId !== therapistId) {
    throw new Error('Not authorized to update location for this booking');
  }

  // Update booking with location
  await bookingDoc.ref.update({
    location: {
      latitude: location.latitude,
      longitude: location.longitude,
      heading: location.heading,
      speed: location.speed,
      accuracy: location.accuracy,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    },
  });

  // Trigger real-time update
  await triggerBookingUpdate(bookingId, 'status', null, { location: booking.location });

  functions.logger.info(`Location updated for booking ${bookingId}`, {
    bookingId,
    therapistId,
  });
}

/**
 * Get current location for a booking (for customer tracking)
 */
export async function getBookingLocation(
  bookingId: string,
  requestingUserId: string
): Promise<LocationUpdate | null> {
  const bookingDoc = await db.collection('bookings').doc(bookingId).get();
  if (!bookingDoc.exists) {
    return null;
  }

  const booking = bookingDoc.data()!;

  // Only allow customer or spa-related users to see location
  if (booking.userId !== requestingUserId) {
    const userDoc = await db.collection('users').doc(requestingUserId).get();
    if (!userDoc.exists) {
      return null;
    }

    const userData = userDoc.data()!;
    const isSpaRelated =
      (userData.role === 'spa_owner' || userData.role === 'spa_staff') &&
      userData.spaData?.spaId === booking.spaId;

    if (!isSpaRelated) {
      return null;
    }
  }

  // Only return location if booking is confirmed and not completed
  if (!['confirmed', 'en_route', 'in_progress'].includes(booking.bookingStatus)) {
    return null;
  }

  return booking.location || null;
}

// ============================================================================
// ETA Calculation
// ============================================================================

/**
 * Calculate estimated time of arrival for en-route therapists
 */
export async function calculateETA(
  therapistId: string,
  bookingId: string
): Promise<{ eta: number | null; distance: number | null }> {
  const bookingDoc = await db.collection('bookings').doc(bookingId).get();
  if (!bookingDoc.exists) {
    return { eta: null, distance: null };
  }

  const booking = bookingDoc.data()!;
  const therapistDoc = await db.collection('therapists').doc(therapistId).get();

  if (!therapistDoc.exists) {
    return { eta: null, distance: null };
  }

  const therapist = therapistDoc.data()!;

  // If booking has location data, calculate distance
  if (booking.location) {
    const therapistLocation = therapist.currentLocation;
    if (!therapistLocation) {
      return { eta: null, distance: null };
    }

    const distance = calculateDistance(
      therapistLocation.latitude,
      therapistLocation.longitude,
      booking.location.latitude,
      booking.location.longitude
    );

    // Estimate travel time (assumes average speed of 30 km/h in city)
    const speed = 30; // km/h
    const etaMinutes = (distance / speed) * 60;

    return {
      eta: Math.round(etaMinutes),
      distance: parseFloat(distance.toFixed(2)),
    };
  }

  return { eta: null, distance: null };
}

/**
 * Calculate distance between two coordinates in kilometers
 */
function calculateDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// Service Progress Tracking
// ============================================================================

export interface ServiceProgress {
  serviceId: string;
  serviceName: string;
  startTime: admin.firestore.Timestamp | null;
  endTime: admin.firestore.Timestamp | null;
  completed: boolean;
}

/**
 * Track progress of individual services within a booking
 */
export async function updateServiceProgress(
  bookingId: string,
  serviceId: string,
  startTime?: Date,
  endTime?: Date
): Promise<void> {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingDoc = await bookingRef.get();

  if (!bookingDoc.exists) {
    functions.logger.warn(`Booking ${bookingId} not found for service progress`);
    return;
  }

  const booking = bookingDoc.data()!;
  let serviceProgress = booking.serviceProgress || [];

  const existingIndex = serviceProgress.findIndex(
    (p: ServiceProgress) => p.serviceId === serviceId
  );

  if (existingIndex >= 0) {
    if (startTime) {
      serviceProgress[existingIndex].startTime = admin.firestore.Timestamp.fromDate(startTime);
    }
    if (endTime) {
      serviceProgress[existingIndex].endTime = admin.firestore.Timestamp.fromDate(endTime);
      serviceProgress[existingIndex].completed = true;
    }
  } else if (startTime) {
    serviceProgress.push({
      serviceId,
      serviceName: (booking.services as BookingServiceLine[] | undefined)?.find((s) => s.serviceId === serviceId)?.name || 'Unknown',
      startTime: admin.firestore.Timestamp.fromDate(startTime),
      endTime: null,
      completed: false,
    });
  }

  await bookingRef.update({
    serviceProgress,
  });

  await triggerBookingUpdate(bookingId, 'service', null, serviceProgress);
}

/**
 * Get overall booking progress percentage
 */
export function getBookingProgress(booking: BookingDocLite): { percentage: number; currentService: string | null } {
  const serviceProgress: ServiceProgress[] = booking.serviceProgress || [];
  const totalServices = booking.services?.length || 1;

  const completedServices = serviceProgress.filter((p) => p.completed).length;
  const percentage = Math.round((completedServices / totalServices) * 100);

  // Find current service (first non-completed)
  const currentService = serviceProgress.find((p) => !p.completed)?.serviceName || null;

  return { percentage, currentService };
}

// ============================================================================
// Auto-transitions (called by scheduled functions)
// ============================================================================

/**
 * Auto-cancel booking if not paid within timeout
 */
// Legacy status — coexists during 14-day Stripe-stub grace; remove on 2026-05-16 (Wave 12).
export async function cancelExpiredDraftBooking(bookingId: string): Promise<void> {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingDoc = await bookingRef.get();

  if (!bookingDoc.exists) return;

  const booking = bookingDoc.data()!;

  if (booking.bookingStatus === 'draft') {
    const now = admin.firestore.Timestamp.now();
    const createdAt = booking.createdAt;
    const ageInSeconds = now.seconds - createdAt.seconds;

    // Cancel after 15 minutes
    if (ageInSeconds > BOOKING_HOLD_DURATION_SECONDS) {
      await transitionBookingStatus(
        bookingId,
        'cancelled',
        'system',
        'auto-cancel',
        'Booking expired due to payment timeout'
      );

      // Release held slot
      const { date, start, end } = booking.slot as { date: string; start: string; end: string };
      const compositeId = `${booking.spaId}_${date}_${booking.therapistId}`;
      const availabilityDoc = await db.collection('availability').doc(compositeId).get();

      if (availabilityDoc.exists) {
        const slots: AvailabilitySlot[] = availabilityDoc.data()?.slots || [];
        const updatedSlots = slots.map((s) => {
          if (s.start === start && s.end === end && s.bookingId === bookingId) {
            return { ...s, available: true, bookingId: null, heldUntil: null };
          }
          return s;
        });
        await availabilityDoc.ref.update({ slots: updatedSlots });
      }

      functions.logger.info(`Expired draft booking cancelled`, { bookingId });
    }
  }
}

/**
 * Auto-transition to en_route 5 minutes before scheduled time
 */
export async function autoTransitionToEnRoute(bookingId: string): Promise<void> {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingDoc = await bookingRef.get();

  if (!bookingDoc.exists) return;

  const booking = bookingDoc.data()!;

  if (booking.bookingStatus === 'confirmed') {
    const now = Date.now();
    const scheduledTime = new Date(`${booking.slot.date}T${booking.slot.start}:00`).getTime();
    const timeUntil = scheduledTime - now;

    // Transition 5 minutes before scheduled time
    if (timeUntil > 0 && timeUntil <= 5 * 60 * 1000) {
      await transitionBookingStatus(
        bookingId,
        'en_route',
        'system',
        'auto-transition',
        'Customer appointment imminent'
      );
    }
  }
}

/**
 * Auto-cancel for no-show (10 minutes after scheduled time without check-in)
 */
export async function autoCancelNoShow(bookingId: string): Promise<void> {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingDoc = await bookingRef.get();

  if (!bookingDoc.exists) return;

  const booking = bookingDoc.data()!;

  if (['confirmed', 'en_route'].includes(booking.bookingStatus) && !booking.checkIn) {
    const now = Date.now();
    const scheduledTime = new Date(`${booking.slot.date}T${booking.slot.start}:00`).getTime();
    const timePast = now - scheduledTime;

    // Cancel 10 minutes after scheduled time
    if (timePast > 10 * 60 * 1000) {
      await transitionBookingStatus(
        bookingId,
        'cancelled',
        'system',
        'no-show',
        'Customer did not check in - no-show fee may apply'
      );

      functions.logger.info(`No-show booking auto-cancelled`, { bookingId });
    }
  }
}
