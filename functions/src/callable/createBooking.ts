import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import {
  CreateBookingDraftInputSchema,
  type CreateBookingDraftInput,
} from '@glamornate/contracts';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import { istDateAtTimeToUtc } from '../utils/date-ist';
import { SERVER_BOOKING_LEAD_TIME_MS } from '../utils/constants';
import { recordBookingMetric } from '../utils/metrics';

const db = admin.firestore();
const logger = createLogger('createBooking');

// Business constants — load from Firestore config in production
const TAX_RATE = Number(process.env.TAX_RATE_PERCENT ?? 18) / 100;
const PLATFORM_FEE_RATE = Number(process.env.PLATFORM_FEE_PERCENT ?? 20) / 100;

export const createBooking = callableOpts({ maxInstances: 100 }).https.onCall(
  withRateLimit(
    { name: 'createBooking', windowMs: 60_000, max: 20 },
    async (data, context) => {
  // Validate authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication required'
    );
  }

  const userId = context.auth.uid;

  logger.info('Booking creation started', { userId, spaId: data?.spaId });

  try {
    // Validate input
    const validated: CreateBookingDraftInput =
      CreateBookingDraftInputSchema.parse(data);

    const { date, start, end } = validated.slot;
    const now = admin.firestore.Timestamp.now();

    // ---- Availability check (best-effort) ----
    // If no availability doc exists (early-stage, no seed data), skip the check
    // and allow booking to proceed. This will be enforced once availability
    // data is seeded.
    let availabilityDoc: admin.firestore.DocumentSnapshot | null = null;

    if (validated.therapistId) {
      const compositeId = `${validated.spaId}_${date}_${validated.therapistId}`;
      const doc = await db.collection('availability').doc(compositeId).get();
      if (doc.exists) {
        availabilityDoc = doc;
        const availability = doc.data();
        type SlotLite = { start: string; end: string; available?: boolean };
        const slotAvailable = (availability?.slots as SlotLite[] | undefined)?.find(
          (s) => s.start === start && s.end === end && s.available
        );
        if (!slotAvailable) {
          throw new functions.https.HttpsError(
            'aborted',
            'This time slot is no longer available. Please select another slot.',
            { error: 'SLOT_UNAVAILABLE' }
          );
        }
      } else {
        logger.warn('No availability doc found — skipping slot check', {
          compositeId, userId,
        });
      }
    }

    // ---- Overlap check helpers ----
    // Confirmed-via-callable bookings store the slot as
    // { date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM' }. Legacy
    // webhook-confirmed records may still carry Timestamp fields.
    // Normalise both to epoch millis so the overlap predicate works
    // regardless of shape.
    const toSlotMs = (slot: unknown): { startMs: number; endMs: number } | null => {
      if (!slot || typeof slot !== 'object') return null;
      const s = slot as {
        date?: string;
        start?: string | { toDate?: () => Date };
        end?: string | { toDate?: () => Date };
      };
      // String-shape: parse the IST wall-clock pair (`date` is YYYY-MM-DD,
      // `start`/`end` are HH:MM) into a UTC instant via `istDateAtTimeToUtc`.
      // Phase 2 (Booking Flow Fix v3.1, 2026-05-02): the legacy
      // `new Date(`${date}T${start}:00`)` interprets the input as the
      // process's local zone — UTC on Cloud Functions — so an IST 23:30 slot
      // landed on the next UTC day and overlap checks silently mismatched.
      if (typeof s.start === 'string' && typeof s.end === 'string' && s.date) {
        const startMs = istDateAtTimeToUtc(s.date, s.start).getTime();
        const endMs = istDateAtTimeToUtc(s.date, s.end).getTime();
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          return { startMs, endMs };
        }
        return null;
      }
      // Timestamp-shape (legacy webhook-confirmed records).
      const startTs = s.start && typeof s.start !== 'string' ? s.start : null;
      const endTs = s.end && typeof s.end !== 'string' ? s.end : null;
      if (startTs?.toDate && endTs?.toDate) {
        return {
          startMs: startTs.toDate().getTime(),
          endMs: endTs.toDate().getTime(),
        };
      }
      return null;
    };

    const incomingStartMs = istDateAtTimeToUtc(date, start).getTime();
    const incomingEndMs = istDateAtTimeToUtc(date, end).getTime();

    // Phase 7 (Booking Flow Fix v3.1, 2026-05-02): server-side lead-time
    // floor. The client filters at 60 minutes for UX; the server enforces
    // a strictly narrower 5-minute floor so a clock-skewed client cannot
    // book into the past. The asymmetry is documented in
    // docs/adr/0008-booking-lead-time-asymmetry.md.
    if (incomingStartMs < Date.now() + SERVER_BOOKING_LEAD_TIME_MS) {
      recordBookingMetric('slot_in_past', { spaId: validated.spaId, userId });
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Selected time has already passed. Please choose a later slot.',
        { error: 'SLOT_IN_PAST' },
      );
    }

    // Build the overlap query factory. The actual `txn.get(...)` happens INSIDE
    // the transaction below so the read is part of the transaction read-set
    // and Firestore can detect concurrent writes (TOCTOU-safe). `.limit(20)`
    // bounds the scan — a user with 20 active confirmed bookings is already
    // abusing the API and a regular user will never have more than 1-2.
    const overlapQuery = db
      .collection('bookings')
      .where('userId', '==', userId)
      .where('bookingStatus', '==', 'confirmed')
      .where('isActive', '==', true)
      .limit(20);

    // Helper used by the transactional path below. Reads the overlap candidates
    // through `txn.get(query)` (so they participate in the txn read-set) and
    // throws `already-exists` if any candidate's window intersects [start, end).
    // Failures are bucketed: known-benign (missing-index) → log+continue, all
    // other failures → propagate.
    const verifyNoOverlap = async (
      txn: admin.firestore.Transaction,
    ): Promise<void> => {
      try {
        const overlapping = await txn.get(overlapQuery);
        for (const bookingDoc of overlapping.docs) {
          const booking = bookingDoc.data();
          const existing = toSlotMs(booking.slot);
          if (!existing) continue;
          if (incomingStartMs < existing.endMs && incomingEndMs > existing.startMs) {
            recordBookingMetric('duplicate_booking', { spaId: validated.spaId, userId });
            throw new functions.https.HttpsError(
              'already-exists',
              'You already have a booking at this time.',
              { error: 'DUPLICATE_BOOKING' },
            );
          }
        }
        recordBookingMetric('overlap_check_ok', { spaId: validated.spaId });
      } catch (overlapError: unknown) {
        if ((overlapError as { code?: string })?.code === 'already-exists') {
          throw overlapError;
        }
        const err = overlapError as { code?: string; message?: string } | undefined;
        const code = err?.code ?? '';
        const message = err?.message ?? '';
        const isBenign =
          code === 'failed-precondition' ||
          /index|requires an index/i.test(message);
        if (!isBenign) {
          logger.error('Overlap check failed — propagating', { userId, error: overlapError });
          throw overlapError;
        }
        recordBookingMetric('overlap_check_skipped', { spaId: validated.spaId, reason: 'missing_index' });
        logger.warn('Overlap check skipped (missing index)', { userId, error: message });
      }
    };

    // ---- Resolve service pricing (server-side only) ----
    let servicesTotal = 0;
    const services: Array<{ serviceId: string; name?: string; price: number }> = [];

    if (validated.serviceIds.length > 0) {
      // Server-side price lookup (client prices are never trusted)
      const spaServiceRefs = validated.serviceIds.map((serviceId) =>
        db.collection('spa_services').doc(`${validated.spaId}_${serviceId}`)
      );
      const globalServiceRefs = validated.serviceIds.map((serviceId) =>
        db.collection('services').doc(serviceId)
      );

      const spaServiceDocs = await db.getAll(...spaServiceRefs);
      const globalServiceDocs = await db.getAll(...globalServiceRefs);

      // Phase 9C (Booking Flow Fix v3.1, 2026-05-02): when the global
      // catalog fallback resolves a price, also verify that the spa
      // *offers* the service. Without this, an attacker can craft a
      // payload combining a cheap spa with an expensive global service the
      // spa never opted into, and a confirmed booking lands on a slot the
      // spa never had to staff. We probe two equally-canonical sources —
      // the spa's `services` array and the optional
      // `spas/{spaId}/services/{serviceId}` subcollection doc — and
      // accept either as proof of binding.
      let spaServicesArray: string[] | null = null;
      let needSpaArray = false;

      for (let i = 0; i < validated.serviceIds.length; i++) {
        const spaServiceDoc = spaServiceDocs[i];
        const globalServiceDoc = globalServiceDocs[i];
        if (
          !(spaServiceDoc.exists && spaServiceDoc.data()?.priceOverride) &&
          (globalServiceDoc.exists && globalServiceDoc.data()?.basePrice)
        ) {
          needSpaArray = true;
          break;
        }
      }

      if (needSpaArray) {
        const spaDoc = await db.collection('spas').doc(validated.spaId).get();
        spaServicesArray = (spaDoc.data()?.services as string[] | undefined) ?? [];
      }

      for (let i = 0; i < validated.serviceIds.length; i++) {
        const serviceId = validated.serviceIds[i];
        const spaServiceDoc = spaServiceDocs[i];
        const globalServiceDoc = globalServiceDocs[i];

        let price: number;
        let name: string | undefined;

        if (spaServiceDoc.exists && spaServiceDoc.data()?.priceOverride) {
          price = spaServiceDoc.data()!.priceOverride;
          name = spaServiceDoc.data()!.name;
        } else if (globalServiceDoc.exists && globalServiceDoc.data()?.basePrice) {
          // Patch 9C: confirm the spa actually offers this service before
          // honoring the global fallback price.
          const isOffered =
            (spaServicesArray ?? []).includes(serviceId) ||
            (await db
              .collection('spas')
              .doc(validated.spaId)
              .collection('services')
              .doc(serviceId)
              .get()).exists;
          if (!isOffered) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This service is not offered by the selected spa.',
              { error: 'SERVICE_NOT_OFFERED_BY_SPA', serviceId, spaId: validated.spaId },
            );
          }
          price = globalServiceDoc.data()!.basePrice;
          name = globalServiceDoc.data()!.name;
        } else {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'Service pricing not available. Please try again later.',
            { error: 'PRICING_UNAVAILABLE', serviceId }
          );
        }

        servicesTotal += price;
        services.push({ serviceId, name, price });
      }
    }

    // Fetch addon prices
    let addonsTotal = 0;
    const addons: Array<{ id: string; name: string; price: number }> = [];

    if (validated.addonIds && validated.addonIds.length > 0) {
      const addonRefs = validated.addonIds.map((addonId) =>
        db.collection('addons').doc(addonId)
      );
      const addonDocs = await db.getAll(...addonRefs);

      for (const addonDoc of addonDocs) {
        if (addonDoc.exists) {
          const addonData = addonDoc.data()!;
          const addonPrice = addonData.price || 0;
          addonsTotal += addonPrice;
          addons.push({ id: addonDoc.id, name: addonData.name || '', price: addonPrice });
        }
      }
    }

    const totalPrice = servicesTotal + addonsTotal;
    const tax = Math.round(totalPrice * TAX_RATE);
    const platformFee = Math.round(totalPrice * PLATFORM_FEE_RATE);
    const total = totalPrice + tax + platformFee;

    // ---- Create booking ----
    const bookingRef = db.collection('bookings').doc();
    const userRef = db.collection('users').doc(userId);

    // Merge customer info: prefer client-provided, backfill from user profile
    const userDoc = await userRef.get();
    const userProfile = userDoc.data();

    // Phase 9A (Booking Flow Fix v3.1, 2026-05-02): trust order for
    // `customer.phone` is (1) verified Firebase Auth phone_number claim,
    // (2) client-supplied value, (3) saved profile. The legacy implementation
    // let a client supply an arbitrary phone number that overrode the
    // verified claim, enabling booking-side impersonation. If the client
    // value differs from the claim we keep the claim and emit a warning so
    // Sentry / Cloud Logging can surface anomalies.
    const verifiedPhone = (context.auth?.token as { phone_number?: string } | undefined)
      ?.phone_number;
    const clientPhone = validated.customer?.phone;
    if (verifiedPhone && clientPhone && verifiedPhone !== clientPhone) {
      logger.warn('createBooking.phone_mismatch', {
        userId,
        verifiedPhone,
        clientPhone,
      });
    }
    const customerInfo = {
      name:
        validated.customer?.name ||
        userProfile?.profile?.displayName ||
        userProfile?.profile?.name ||
        '',
      email: userProfile?.profile?.email || '',
      phone: verifiedPhone ?? clientPhone ?? userProfile?.profile?.phone ?? '',
    };

    const bookingData = {
      userId,
      customer: customerInfo,
      spaId: validated.spaId,
      therapistId: validated.therapistId || null,
      serviceIds: validated.serviceIds,
      services,
      addons,
      slot: { date, start, end, duration: validated.slot.duration },
      pricing: {
        services: servicesTotal,
        addons: addonsTotal,
        tax,
        discount: 0,
        platformFee,
        total,
        currency: 'INR',
      },
      bookingStatus: 'confirmed' as const,
      statusHistory: [{
        status: 'confirmed',
        from: null,
        to: 'confirmed',
        actor: 'customer',
        actorId: userId,
        timestamp: now,
        reason: 'Booking created (pay-at-spa)',
      }],
      // Phase 1 (Stripe removal, 2026-05-02) — pay-at-spa is the only mode.
      // `paymentCollectedAt`, `paymentCollectedBy`, `paymentAmountCollected`
      // are populated when the spa marks the booking as collected via the
      // staff console; null at booking-create time.
      paymentMode: 'pay_at_spa' as const,
      paymentCollectedAt: null,
      paymentCollectedBy: null,
      paymentAmountCollected: null,
      notes: validated.customer?.notes || validated.notes || '',
      specialRequests: validated.specialRequests || '',
      reminderSent: { at_24hr: false, at_2hr: false },
      createdAt: now,
      updatedAt: now,
      isActive: true,
      createdBy: 'customer',
      // Phase 2 location fields. `bookingLocation` is always present (zod
      // applies `.default('spa')` for legacy clients). `customerLocation`
      // uses a conditional spread so the field is `undefined` rather than
      // `null` on in-spa bookings — Firestore strips undefined from the
      // write payload and reads back through `BookingCustomerLocationSchema
      // .optional()` parse cleanly. Writing `null` would fail the optional
      // schema parse on every read.
      bookingLocation: validated.bookingLocation,
      ...(validated.customerLocation && {
        customerLocation: validated.customerLocation,
      }),
    };

    if (availabilityDoc) {
      // Full atomic path: re-verify no overlap + reserve slot + create
      // confirmed booking in one transaction. The overlap re-check uses
      // `txn.get(overlapQuery)` so a concurrent confirmed booking cannot
      // slip through between the read and the write (TOCTOU-safe). The
      // availability slot update further guards against two concurrent
      // bookings for the same (spa, therapist, date, start, end) — the
      // second transaction will see `available: false` on its
      // transactional read and fail to find the slotIndex, so we abort
      // with `already-exists`.
      await db.runTransaction(async (transaction) => {
        // ALL reads must come before any writes inside a Firestore txn.
        const availDoc = await transaction.get(availabilityDoc!.ref);
        await verifyNoOverlap(transaction);

        if (availDoc.exists) {
          const slots = availDoc.data()?.slots || [];
          const slotIndex = slots.findIndex(
            (s: { start: string; end: string; available: boolean }) =>
              s.start === start && s.end === end && s.available
          );

          if (slotIndex === -1) {
            throw new functions.https.HttpsError(
              'aborted',
              'This time slot is no longer available. Please select another slot.',
              { error: 'SLOT_UNAVAILABLE' },
            );
          }

          // Phase 1 (Stripe removal, 2026-05-02) — slot is reserved
          // permanently for a confirmed pay-at-spa booking. `heldUntil`
          // is no longer set since drafts/holds were collapsed away.
          slots[slotIndex] = {
            ...slots[slotIndex],
            available: false,
            bookingId: bookingRef.id,
          };
          transaction.update(availabilityDoc!.ref, { slots });
        }

        transaction.set(bookingRef, bookingData);
      });
    } else {
      // No availability doc path: still wrap in a transaction so the overlap
      // re-check is TOCTOU-safe (otherwise a concurrent booking could slip
      // in between the pre-txn check we removed and this write).
      await db.runTransaction(async (transaction) => {
        await verifyNoOverlap(transaction);
        transaction.set(bookingRef, bookingData);
      });
    }

    logger.info('Booking created', {
      userId, spaId: validated.spaId, bookingId: bookingRef.id, total,
    });
    recordBookingMetric('booking_created', { spaId: validated.spaId, outcome: 'ok' });

    return {
      success: true,
      bookingId: bookingRef.id,
      pricing: {
        services: servicesTotal, addons: addonsTotal, tax,
        discount: 0, platformFee, total, currency: 'INR',
      },
    };

  } catch (error: unknown) {
    logger.error('Booking creation failed', { userId, spaId: data?.spaId, error });
    throw handleError(error);
  }
    },
  ),
);

// Phase 1 (Stripe removal, 2026-05-02) — backward-compat alias.
// Pinned APKs that still call `createBookingDraft` keep working until they
// roll forward. Remove this alias when the alias-deprecation wave runs
// (target: 2026-05-16 alongside the Stripe-webhook stub deletion).
export const createBookingDraft = createBooking;
