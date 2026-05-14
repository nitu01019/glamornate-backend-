import * as admin from 'firebase-admin';

const db = admin.firestore();

// ============================================================================
// Firestore Document Interfaces (for type-safe data access)
// ============================================================================

interface BookingDocData {
  id: string;
  slot: { start: string; end: string; date: string };
  therapistId: string | null;
  bookingStatus: string;
  createdAt?: { toDate: () => Date };
  [key: string]: unknown;
}

interface SpaDocData {
  operatingHours?: Record<string, { isOpen?: boolean; open: string; close: string }>;
  [key: string]: unknown;
}

interface TherapistDocData {
  id: string;
  onLeave?: boolean;
  onLeaveFrom?: { toDate: () => Date };
  onLeaveTo?: { toDate: () => Date };
  availability?: Record<string, Array<{ start: string; end: string }>>;
  [key: string]: unknown;
}

// ============================================================================
// Availability Types
// ============================================================================

export interface Slot {
  start: string; // HH:MM format
  end: string;   // HH:MM format
  duration: number; // minutes
  available: boolean;
  bookingId?: string;
  heldUntil?: admin.firestore.Timestamp;
}

export interface AvailabilityData {
  compositeId: string;
  date: string; // YYYY-MM-DD format
  spaId: string;
  therapistId?: string;
  slots: Slot[];
  lastCalculatedAt: admin.firestore.Timestamp;
  expiresAt: admin.firestore.Timestamp;
}

// ============================================================================
// Slot Generation
// ============================================================================

/**
 * Generate time slots for a given date and operating hours
 */
export function generateTimeSlots(
  openTime: string,     // HH:MM
  closeTime: string,    // HH:MM
  slotDuration: number = 30  // minutes
): Slot[] {
  const [openHour, openMin] = openTime.split(':').map(Number);
  const [closeHour, closeMin] = closeTime.split(':').map(Number);

  const slots: Slot[] = [];
  const openingMins = openHour * 60 + openMin;
  const closingMins = closeHour * 60 + closeMin;

  let currentMins = openingMins;

  const formatTime = (mins: number): string => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  while (currentMins + slotDuration <= closingMins) {
    const start = formatTime(currentMins);
    const end = formatTime(currentMins + slotDuration);

    slots.push({
      start,
      end,
      duration: slotDuration,
      available: true,
      bookingId: undefined,
    });

    currentMins += slotDuration;
  }

  return slots;
}

/**
 * Mark slots as unavailable based on existing bookings
 */
export async function markUnavailableSlots(
  slots: Slot[],
  spaId: string,
  date: string,
  therapistId?: string
): Promise<Slot[]> {
  // Query bookings for the given date.
  // Post-Stripe pay-at-spa flow: bookings move directly to 'confirmed' on creation,
  // so 'draft' / 'payment_pending' are no longer reachable in the active state machine.
  let bookingsQuery = db.collection('bookings')
    .where('spaId', '==', spaId)
    .where('slot.date', '==', date)
    .where('bookingStatus', 'in', ['confirmed', 'en_route', 'in_progress'])
    .where('isActive', '==', true);

  if (therapistId) {
    bookingsQuery = bookingsQuery.where('therapistId', '==', therapistId);
  }

  const bookingsSnapshot = await bookingsQuery.get();
  const bookings = bookingsSnapshot.docs.map(doc => {
    return { ...doc.data(), id: doc.id } as BookingDocData;
  });

  // Mark slots as unavailable
  const slotMap = new Map<string, Slot>();
  slots.forEach(slot => slotMap.set(`${slot.start}-${slot.end}`, { ...slot }));

  for (const booking of bookings) {
    const { start, end } = booking.slot;
    const slotKey = `${start}-${end}`;
    const slot = slotMap.get(slotKey);

    if (slot) {
      // Check if it's the same therapist (or if no therapist specified)
      const therapistMatch = !therapistId || booking.therapistId === therapistId || booking.therapistId === null;

      if (therapistMatch) {
        slot.available = false;
        slot.bookingId = booking.id;
        // Post-Stripe pay-at-spa flow: no payment hold window — bookings go straight
        // to 'confirmed' on creation, so heldUntil is no longer applied here.
      }
    }
  }

  return Array.from(slotMap.values());
}

/**
 * Merge overlapping slots based on service duration requirements
 */
export function mergeSlotsForServiceDuration(
  slots: Slot[],
  serviceDuration: number
): Slot[] {
  if (serviceDuration <= 30) {
    return slots;
  }

  // Calculate how many 30-min slots are needed
  const slotCount = Math.ceil(serviceDuration / 30);
  const mergedSlots: Slot[] = [];

  for (let i = 0; i <= slots.length - slotCount; i++) {
    const startSlot = slots[i];
    const endSlot = slots[i + slotCount - 1];

    // Check if all required slots are available
    const allAvailable = slots.slice(i, i + slotCount).every(s => s.available);

    if (allAvailable) {
      mergedSlots.push({
        start: startSlot.start,
        end: endSlot.end,
        duration: serviceDuration,
        available: true,
      });
    }
  }

  return mergedSlots;
}

// ============================================================================
// Availability Retrieval
// ============================================================================

/**
 * Get availability for a specific spa and date
 */
export async function getAvailability(
  spaId: string,
  date: string,
  therapistId?: string
): Promise<AvailabilityData | null> {
  const compositeId = therapistId
    ? `${spaId}_${date}_${therapistId}`
    : `${spaId}_${date}_any`;

  const doc = await db.collection('availability').doc(compositeId).get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data()!;

  // Check if availability is expired (5 min TTL)
  const now = admin.firestore.Timestamp.now();
  if (data.expiresAt && data.expiresAt.toDate() < now.toDate()) {
    return null;
  }

  return data as AvailabilityData;
}

/**
 * Get available slots for a specific service duration
 */
export async function getAvailableSlots(
  spaId: string,
  date: string,
  serviceDuration: number,
  therapistId?: string
): Promise<Slot[]> {
  const availability = await getAvailability(spaId, date, therapistId);

  if (!availability) {
    return [];
  }

  const availableSlots = availability.slots.filter(s => s.available);

  // Return merged slots if service duration > 30 minutes
  return mergeSlotsForServiceDuration(availableSlots, serviceDuration);
}

/**
 * Check if a specific slot is available
 */
export async function isSlotAvailable(
  spaId: string,
  date: string,
  startTime: string,
  endTime: string,
  therapistId?: string
): Promise<boolean> {
  const availability = await getAvailability(spaId, date, therapistId);

  if (!availability) {
    return false;
  }

  const slot = availability.slots.find(
    s => s.start === startTime && s.end === endTime
  );

  if (!slot) {
    return false;
  }

  // Check if slot is being held and if hold has expired
  if (slot.heldUntil) {
    const now = admin.firestore.Timestamp.now();
    if (now.toDate() > slot.heldUntil.toDate()) {
      // Hold has expired, slot should be available
      return true;
    }
  }

  return slot.available;
}

// ============================================================================
// Availability Calculation (called by scheduled function)
// ============================================================================

export async function calculateAvailabilityForDate(
  date: string,
  spaId: string
): Promise<void> {
  const spaDoc = await db.collection('spas').doc(spaId).get();
  if (!spaDoc.exists) {
    return;
  }

  const spa = spaDoc.data()! as SpaDocData;
  const spaIdValue = spaDoc.id;

  // Get day of week. Operating hours docs in the wild use BOTH short ("mon")
  // and long ("monday") keys depending on which seed populated them — look
  // up both forms so we don't surface "no slots" just because of a key mismatch.
  const [year, month, day] = date.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dowShort = dateObj.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
  const dowLong = dateObj.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const dayHours =
    spa.operatingHours?.[dowShort] ?? spa.operatingHours?.[dowLong];

  // Check if spa is open on this day
  if (!dayHours?.isOpen) {
    return;
  }

  const { open: openStr, close: closeStr } = dayHours;
  const dayOfWeek = dowShort;

  // Get therapists for this spa
  const therapistsQuery = db.collection('therapists')
    .where('spaId', '==', spaIdValue)
    .where('isActive', '==', true);

  const therapistsSnapshot = await therapistsQuery.get();
  const therapists = therapistsSnapshot.docs.map(doc => {
    return { ...doc.data(), id: doc.id } as TherapistDocData;
  });

  // Calculate "any therapist" availability
  const anyTherapistSlots = generateTimeSlots(openStr, closeStr);
  const availableAnySlots = await markUnavailableSlots(anyTherapistSlots, spaIdValue, date);

  const compositeIdAny = `${spaIdValue}_${date}_any`;
  await db.collection('availability').doc(compositeIdAny).set({
    compositeId: compositeIdAny,
    date,
    spaId: spaIdValue,
    therapistId: null,
    slots: availableAnySlots,
    lastCalculatedAt: admin.firestore.Timestamp.now(),
    expiresAt: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
    ),
  }, { merge: true });

  // Calculate availability for each therapist
  for (const therapist of therapists) {
    // Check if therapist is on leave
    if (therapist.onLeave) {
      const leaveFrom = therapist.onLeaveFrom?.toDate();
      const leaveTo = therapist.onLeaveTo?.toDate();
      if (leaveFrom && leaveTo && dateObj >= leaveFrom && dateObj <= leaveTo) {
        continue;
      }
    }

    // Get therapist's custom availability
    let therapistOpen = openStr;
    let therapistClose = closeStr;

    if (therapist.availability?.[dayOfWeek]) {
      const daySlots = therapist.availability[dayOfWeek];
      if (daySlots.length === 0) {
        continue; // Therapist not working this day
      }
      therapistOpen = daySlots[0]?.start || openStr;
      therapistClose = daySlots[daySlots.length - 1]?.end || closeStr;
    }

    const therapistSlots = generateTimeSlots(therapistOpen, therapistClose);
    const availableTherapistSlots = await markUnavailableSlots(
      therapistSlots,
      spaIdValue,
      date,
      therapist.id
    );

    const compositeId = `${spaIdValue}_${date}_${therapist.id}`;
    await db.collection('availability').doc(compositeId).set({
      compositeId,
      date,
      spaId: spaIdValue,
      therapistId: therapist.id,
      slots: availableTherapistSlots,
      lastCalculatedAt: admin.firestore.Timestamp.now(),
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
      ),
    }, { merge: true });
  }
}

/**
 * Hold a slot temporarily (when booking draft is created)
 */
export async function holdSlot(
  spaId: string,
  date: string,
  startTime: string,
  endTime: string,
  bookingId: string,
  therapistId?: string,
  holdDurationMinutes: number = 15
): Promise<boolean> {
  const compositeId = therapistId
    ? `${spaId}_${date}_${therapistId}`
    : `${spaId}_${date}_any`;

  const docRef = db.collection('availability').doc(compositeId);

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) {
        throw new Error('Availability document not found');
      }

      const availability = doc.data();
      const slots = availability?.slots || [];

      const slotIndex = (slots as Slot[]).findIndex(
        (s) => s.start === startTime && s.end === endTime
      );
      if (slotIndex === -1) {
        throw new Error('Slot not found');
      }

      if (!slots[slotIndex].available) {
        throw new Error('Slot not available');
      }

      slots[slotIndex] = {
        ...slots[slotIndex],
        available: false,
        bookingId,
        heldUntil: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + holdDurationMinutes * 60 * 1000)
        ),
      };

      transaction.update(docRef, { slots });
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Release a held slot (when booking is cancelled or expires)
 */
export async function releaseSlot(
  spaId: string,
  date: string,
  startTime: string,
  endTime: string,
  bookingId: string,
  therapistId?: string
): Promise<boolean> {
  const compositeId = therapistId
    ? `${spaId}_${date}_${therapistId}`
    : `${spaId}_${date}_any`;

  const docRef = db.collection('availability').doc(compositeId);

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) {
        throw new Error('Availability document not found');
      }

      const availability = doc.data();
      const slots = availability?.slots || [];

      const slotIndex = (slots as Slot[]).findIndex(
        (s) => s.start === startTime && s.end === endTime && s.bookingId === bookingId
      );

      if (slotIndex === -1) {
        throw new Error('Slot not found or not held by this booking');
      }

      slots[slotIndex] = {
        ...slots[slotIndex],
        available: true,
        bookingId: undefined,
        heldUntil: undefined,
      };

      transaction.update(docRef, { slots });
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up expired holds
 */
export async function cleanupExpiredHolds(date: string): Promise<number> {
  const now = admin.firestore.Timestamp.now();
  const availabilityQuery = db.collection('availability')
    .where('date', '==', date)
    .where('expiresAt', '<=', now);

  const snapshot = await availabilityQuery.get();
  let count = 0;

  for (const doc of snapshot.docs) {
    const availability = doc.data();
    const slots = availability.slots || [];

    let updated = false;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].heldUntil && slots[i].heldUntil.toDate() <= now.toDate()) {
        slots[i].available = true;
        slots[i].bookingId = undefined;
        slots[i].heldUntil = undefined;
        updated = true;
      }
    }

    if (updated) {
      await doc.ref.update({ slots });
      count++;
    }
  }

  return count;
}
