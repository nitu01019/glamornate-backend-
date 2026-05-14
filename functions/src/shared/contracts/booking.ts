import { z } from 'zod';
import { apiResponseSchema } from './envelope';

/**
 * CartItem — minimal wire-level representation used by the POST /bookings
 * validator and Firestore writes. The frontend cart UI reads additional
 * view-model fields (categoryName, subcategory, etc.); those live on
 * `CartItemView` below.
 */
export const CartItemSchema = z.object({
  serviceId: z.string().min(1),
  serviceName: z.string().optional(),
  quantity: z.number().int().positive(),
  price: z.number().nonnegative().optional(),
  duration: z.number().int().nonnegative().optional(),
});
export type CartItem = z.infer<typeof CartItemSchema>;

/**
 * CartItemView — the frontend's canonical view-model used by the cart UI,
 * review step, and booking persistence. Extends the wire-level `CartItem`
 * with required display fields (categoryName, subcategory) plus optional
 * discount/image metadata. Structurally assignable to `CartItem` because
 * every field on `CartItem` is either present here or optional there.
 */
export const CartItemViewSchema = z.object({
  serviceId: z.string().min(1),
  serviceName: z.string(),
  categoryName: z.string(),
  subcategory: z.string(),
  price: z.number().nonnegative(),
  originalPrice: z.number().nonnegative().optional(),
  discount: z.number().optional(),
  quantity: z.number().int().positive(),
  duration: z.number().int().nonnegative(),
  image: z.string().optional(),
});
export type CartItemView = z.infer<typeof CartItemViewSchema>;

export const BookingAddressSchema = z.object({
  fullAddress: z.string().min(1),
  city: z.string().min(1),
  pincode: z.string().min(1),
  phone: z.string().min(1),
  landmark: z.string().optional(),
});
export type BookingAddress = z.infer<typeof BookingAddressSchema>;

export const BookingLocationSchema = z.enum(['spa', 'home']);
export type BookingLocation = z.infer<typeof BookingLocationSchema>;

/**
 * BookingCustomerLocation — canonical wire-level shape for the customer's
 * captured location on every home-service booking. Persisted on the booking
 * Firestore doc; surfaced on the spa-side detail page; injected into the
 * confirmed/en-route notification templates as `addressText` + Maps URL.
 *
 * Notes
 * -----
 * - `coords.accuracy` is bounded at 100km because anything beyond that is
 *   effectively unusable for technician dispatch.
 * - `placeId` is `.min(1)` to reject empty strings from Places API responses
 *   (otherwise `buildMapsUrl` produces `&destination_place_id=` with empty
 *   value).
 * - `addressText` and `additionalDetails` MUST be sanitized via
 *   `sanitizeInput()` from `backend/functions/src/utils/validator.ts:113`
 *   BEFORE injection into any template string (XSS / SMS spoof surface).
 */
export const BookingCustomerLocationSchema = z.object({
  coords: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100000),
  }),
  source: z.enum(['gps', 'address_typed', 'address_picked_on_map']),
  addressText: z.string().min(1).max(500),
  placeId: z.string().min(1).optional(),
  additionalDetails: z.string().max(500).optional(),
  capturedAt: z.string().datetime(),
});
export type BookingCustomerLocation = z.infer<typeof BookingCustomerLocationSchema>;

/**
 * ServiceItemSchema — wire-level service item attached to a
 * createBookingDraft input. Mirrors the inline schema previously declared at
 * `backend/functions/src/callable/createBookingDraft.ts:17` so the callable
 * can `import { CreateBookingDraftInputSchema }` directly.
 */
export const ServiceItemSchema = z.object({
  serviceId: z.string(),
  serviceName: z.string().optional(),
  price: z.number().nonnegative(),
  quantity: z.number().int().positive().optional().default(1),
});
export type ServiceItem = z.infer<typeof ServiceItemSchema>;

/**
 * CreateBookingDraftInputSchema — the single source of truth for the
 * createBookingDraft callable input shape. Reuses BookingLocationSchema
 * (existing `'spa' | 'home'` enum) instead of duplicating it.
 *
 * Forward-compat with old APK clients
 * -----------------------------------
 * `bookingLocation` defaults to `'spa'` so an old APK client that never
 * sends the field is treated as an in-spa booking (the legacy default).
 * The `superRefine` fires ONLY when `bookingLocation === 'home'` is
 * explicit AND `customerLocation` is missing — this eliminates the
 * version-skew break where old APKs would otherwise crash on a required
 * field.
 */
export const CreateBookingDraftInputSchema = z
  .object({
    spaId: z.string().min(1),
    therapistId: z.string().nullish(),
    serviceIds: z.array(z.string()).min(1),
    addonIds: z.array(z.string()).nullish().default([]),
    slot: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      duration: z.number().positive(),
    }),
    services: z.array(ServiceItemSchema).nullish(),
    customer: z
      .object({
        name: z.string().nullish(),
        phone: z.string().nullish(),
        notes: z.string().nullish(),
      })
      .nullish(),
    notes: z.string().nullish(),
    specialRequests: z.string().nullish(),
    bookingLocation: BookingLocationSchema.default('spa'),
    customerLocation: BookingCustomerLocationSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.bookingLocation === 'home' && !v.customerLocation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerLocation'],
        message: 'customerLocation is required for home-service bookings',
      });
    }
  });
export type CreateBookingDraftInput = z.infer<typeof CreateBookingDraftInputSchema>;

/**
 * BookingRequest — POST /bookings validator. Used by the backend middleware
 * to parse the incoming payload. `userId`, `totalAmount`, and `totalDuration`
 * are NOT accepted from the client (the authenticated uid is derived from
 * the token, totals are computed server-side from the authoritative service
 * catalog).
 */
export const BookingRequestSchema = z
  .object({
    services: z.array(CartItemSchema).min(1),
    date: z.string().min(1),
    timeSlot: z.string().min(1),
    location: BookingLocationSchema,
    address: BookingAddressSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.location === 'home' && !data.address) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Address is required for home bookings',
      });
    }
  });
export type BookingRequest = z.infer<typeof BookingRequestSchema>;

/**
 * BookingPersistence — the full persistence shape emitted by
 * `frontend/src/lib/firebase-client/bookings.ts#createBooking`. Adds
 * server-supplied fields on top of the wire-level BookingRequest:
 *   - `userId` (from token)
 *   - `totalAmount` + `totalDuration` (computed server-side)
 *   - services typed as view-model `CartItemView[]`
 * This is the variant the frontend re-exports as its own `BookingRequest`.
 */
export const BookingPersistenceSchema = z.object({
  userId: z.string().min(1),
  services: z.array(CartItemViewSchema).min(1),
  date: z.string().min(1),
  timeSlot: z.string().min(1),
  location: BookingLocationSchema,
  address: BookingAddressSchema.optional(),
  totalAmount: z.number().nonnegative(),
  totalDuration: z.number().int().nonnegative(),
  notes: z.string().max(2000).optional(),
  // Phase 2: mandatory-location-capture fields. Both optional in persistence
  // (legacy bookings predating Phase 2 lack them) but mandatory in the
  // create-draft validator when bookingLocation === 'home'. Readers must
  // never crash on legacy docs — `.optional()` enforces that.
  bookingLocation: BookingLocationSchema.optional(),
  customerLocation: BookingCustomerLocationSchema.optional(),
});
export type BookingPersistence = z.infer<typeof BookingPersistenceSchema>;

/**
 * BookingRecordStatus — canonical status union for the customer-facing
 * BookingRecord view-model. Phase 1 (Stripe removal, 2026-05-02) collapsed
 * the legacy 7-value union (which carried `draft`, `payment_pending`, and
 * `pending`) down to a 6-value pay-at-spa lifecycle. The Firestore-side
 * `Booking.bookingStatus` schema mirrors this exact set; the migration
 * script (`backend/functions/src/scripts/migrate-remove-stripe.ts`) sweeps
 * any residual rows in the retired states.
 */
export const BookingRecordStatusSchema = z.enum([
  'confirmed',
  'en_route',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
]);
export type BookingRecordStatus = z.infer<typeof BookingRecordStatusSchema>;

/**
 * BookingRecord — public/wire representation of a booking Firestore doc.
 * `bookingStatus` is a loose string because passthrough docs may carry
 * future status values; the strict frontend view-model uses
 * `BookingRecordViewSchema` below.
 */
export const BookingRecordSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    bookingStatus: z.string(),
    services: z.array(CartItemSchema),
    date: z.string(),
    timeSlot: z.string(),
    location: BookingLocationSchema,
    address: BookingAddressSchema.optional(),
    totalAmount: z.number().nonnegative().optional(),
    totalDuration: z.number().int().nonnegative().optional(),
    notes: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    // Phase 2: mandatory-location-capture fields. Optional on the record
    // shape because legacy docs predating Phase 2 lack them. The
    // `.passthrough()` already auto-includes unknown fields so consumers
    // that simply iterate over keys keep working; declaring them
    // explicitly here gives type-narrowing on consumers that read them.
    bookingLocation: BookingLocationSchema.optional(),
    customerLocation: BookingCustomerLocationSchema.optional(),
  })
  .passthrough();
export type BookingRecord = z.infer<typeof BookingRecordSchema>;

/**
 * BookingRecordView — strict frontend view-model for a persisted booking.
 * Wraps the full BookingPersistence shape with Firestore metadata
 * (id, bookingNumber) and the strict BookingStatus union. This is what the
 * frontend re-exports as its own `BookingRecord`.
 */
export const BookingRecordViewSchema = BookingPersistenceSchema.extend({
  id: z.string().min(1),
  bookingNumber: z.string().min(1),
  status: BookingRecordStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BookingRecordView = z.infer<typeof BookingRecordViewSchema>;

export const BookingResponseSchema = apiResponseSchema(BookingRecordSchema);
export type BookingResponse = z.infer<typeof BookingResponseSchema>;
