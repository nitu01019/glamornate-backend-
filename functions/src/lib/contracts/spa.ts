import { z } from 'zod';
import { apiResponseSchema } from './envelope';
import {
  LocationSchema,
  PublicLocationSchema,
  RatingSchema,
  SpaCategorySchema,
} from './primitives';

/**
 * ContactSchema — phone + optional reach channels for a spa. Used on both
 * the Firestore doc and the public DTO.
 */
export const ContactSchema = z.object({
  phone: z.string(),
  email: z.string().optional(),
  website: z.string().optional(),
  whatsapp: z.string().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const PublicContactSchema = z
  .object({
    phone: z.string().optional(),
    email: z.string().optional(),
    website: z.string().optional(),
    whatsapp: z.string().optional(),
  })
  .partial();

/**
 * OperatingHoursSchema — day-keyed open/close schedule. Loosely typed at the
 * contract boundary because Firestore stores it as a free-form map.
 */
export const OperatingHoursSchema = z.record(
  z.object({
    open: z.string(),
    close: z.string(),
    isOpen: z.boolean(),
  }),
);
export type OperatingHours = z.infer<typeof OperatingHoursSchema>;

export const SpaTierSchema = z.enum(['basic', 'premium', 'partner']);
export type SpaTier = z.infer<typeof SpaTierSchema>;

export const SpaStatusSchema = z.enum([
  'active',
  'pending',
  'suspended',
  'verified',
  'rejected',
]);
export type SpaStatus = z.infer<typeof SpaStatusSchema>;

export const AmenitySchema = z.enum([
  'parking',
  'wifi',
  'shower',
  'locker',
  'ac',
  'music',
  'refreshments',
]);
export type Amenity = z.infer<typeof AmenitySchema>;

/**
 * CommissionSchema — platform commission configuration. Internal/server-only;
 * stripped from the public DTO.
 */
export const CommissionSchema = z.object({
  platformPercentage: z.number().min(0).max(100),
  fixedFee: z.number().nonnegative(),
});
export type Commission = z.infer<typeof CommissionSchema>;

/**
 * SpaPayoutConfigSchema — bank account + payout cadence. Internal/server-only;
 * stripped from the public DTO.
 */
export const SpaPayoutConfigSchema = z.object({
  bankAccount: z.object({
    accountNumber: z.string(),
    ifsc: z.string(),
    accountName: z.string(),
  }),
  payoutFrequency: z.enum(['daily', 'weekly', 'monthly']),
  nextPayoutDate: z.string().optional(),
});
export type SpaPayoutConfig = z.infer<typeof SpaPayoutConfigSchema>;

/**
 * VerificationSchema — KYC document tracking. Internal/server-only; stripped
 * from the public DTO (document URLs are sensitive).
 */
export const VerificationSchema = z.object({
  submittedAt: z.string(),
  approvedAt: z.string().optional(),
  documents: z.array(
    z.object({
      type: z.string(),
      url: z.string(),
      status: z.enum(['pending', 'approved', 'rejected']),
    }),
  ),
});
export type Verification = z.infer<typeof VerificationSchema>;

/**
 * StatisticsSchema — revenue + booking counters. Internal/server-only;
 * stripped from the public DTO.
 */
export const StatisticsSchema = z.object({
  totalBookings: z.number().int().nonnegative(),
  revenue: z.number().nonnegative(),
  averageRating: z.number().min(0).max(5),
  activeStaff: z.number().int().nonnegative(),
});
export type Statistics = z.infer<typeof StatisticsSchema>;

/**
 * SEOSchema — marketing metadata. Public.
 */
export const SEOSchema = z.object({
  metaTitle: z.string(),
  metaDescription: z.string(),
  keywords: z.array(z.string()),
});
export type SEO = z.infer<typeof SEOSchema>;

/**
 * SpaFirestoreDocSchema — the canonical Firestore document shape written by
 * the backend during spa onboarding + admin updates. Every field here is
 * present on an active spa doc. Internal/sensitive fields (commission,
 * payout, verification, statistics, ownerId) must be stripped before the doc
 * is emitted to unauthenticated consumers — see `spaFirestoreDocToPublicDto`.
 *
 * IMPORTANT: do NOT hand this shape to the frontend marketing surface. Use
 * SpaPublicDto instead.
 */
export const SpaFirestoreDocSchema = z.object({
  // NOTE: `id` is NOT a field on the stored Firestore document — it is the
  // document reference, attached post-fetch by callers (`{ id: snap.id, ...doc.data() }`).
  // Adding it to this schema would duplicate it in every such spread.
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  shortDescription: z.string(),
  featuredImage: z.string(),
  gallery: z.array(z.string()),
  videoUrl: z.string().optional(),
  location: LocationSchema,
  contact: ContactSchema,
  categories: z.array(SpaCategorySchema),
  amenities: z.array(AmenitySchema),
  rating: RatingSchema,
  tier: SpaTierSchema,
  // --- internal / server-only fields below ---
  commission: CommissionSchema,
  payout: SpaPayoutConfigSchema,
  operatingHours: OperatingHoursSchema,
  status: SpaStatusSchema,
  verification: VerificationSchema.optional(),
  statistics: StatisticsSchema,
  seo: SEOSchema,
  searchIndex: z.string().optional(),
  isActive: z.boolean(),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpaFirestoreDoc = z.infer<typeof SpaFirestoreDocSchema>;

/**
 * SpaPublicDtoSchema — the passthrough public wire shape emitted by
 * `/spas` and `/spas/:id`. Every field is optional because (a) legacy docs
 * may lack newer fields, (b) this is the type the frontend marketing pages
 * consume, and they already guard on presence.
 *
 * Historical name: `SpaSchema` — alias preserved below for backwards
 * compatibility with existing imports.
 */
export const SpaPublicDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    slug: z.string().optional(),
    isActive: z.boolean().optional(),
    status: z.string().optional(),
    featuredImage: z.string().optional(),
    city: z.string().optional(),
    address: z.string().optional(),
    rating: RatingSchema.partial().optional(),
    reviewCount: z.number().int().nonnegative().optional(),
    priceRange: z
      .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
      .optional(),
    categories: z.array(z.string()).optional(),
    amenities: z.array(z.string()).optional(),
    images: z.array(z.string()).optional(),
    services: z.array(z.unknown()).optional(),
    location: PublicLocationSchema.optional(),
    contact: PublicContactSchema.optional(),
    operatingHours: z.unknown().optional(),
  })
  .passthrough();
export type SpaPublicDto = z.infer<typeof SpaPublicDtoSchema>;

/**
 * Backwards-compatible aliases for callers that already imported the
 * historical `Spa` / `SpaSchema`. New code should use `SpaPublicDto` /
 * `SpaPublicDtoSchema` explicitly.
 */
export const SpaSchema = SpaPublicDtoSchema;
export type Spa = SpaPublicDto;

/**
 * Codec: strip internal fields from a Firestore spa doc to produce the
 * public DTO. Used by backend serializers before emitting /spas and
 * /spas/:id responses.
 *
 * `doc` is the Firestore document shape (does NOT include `id` — Firestore
 * carries `id` on the ref, not the data); pass the ref id in `id`.
 *
 * Fields stripped:
 *   - commission (platform fees)
 *   - payout (bank account)
 *   - verification (KYC document URLs)
 *   - statistics (revenue + booking counters)
 *   - ownerId (server-only actor reference)
 *   - searchIndex (internal search token)
 */
export function spaFirestoreDocToPublicDto(
  doc: SpaFirestoreDoc,
  id: string,
): SpaPublicDto {
  const {
    commission: _commission,
    payout: _payout,
    verification: _verification,
    statistics: _statistics,
    ownerId: _ownerId,
    searchIndex: _searchIndex,
    ...publicFields
  } = doc;
  void _commission;
  void _payout;
  void _verification;
  void _statistics;
  void _ownerId;
  void _searchIndex;
  // `publicFields` carries: name, slug, description, shortDescription,
  // featuredImage, gallery, videoUrl, location, contact, categories,
  // amenities, rating, tier, operatingHours, status, seo, isActive,
  // createdAt, updatedAt. Combined with `id`, this matches SpaPublicDto
  // (passthrough allows the extra shortDescription/gallery/tier fields).
  return { id, ...publicFields } as SpaPublicDto;
}

export const SpaListPaginationSchema = z.object({
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const SpaListPayloadSchema = z.object({
  spas: z.array(SpaPublicDtoSchema),
  pagination: SpaListPaginationSchema,
  filters: z.record(z.unknown()).optional(),
});

export const SpasResponseSchema = apiResponseSchema(SpaListPayloadSchema);
export type SpasResponse = z.infer<typeof SpasResponseSchema>;

export const SpaDetailResponseSchema = apiResponseSchema(SpaPublicDtoSchema);
export type SpaDetailResponse = z.infer<typeof SpaDetailResponseSchema>;

export const SpasListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().optional(),
  city: z.string().optional(),
  category: z.string().optional(),
  status: z.string().default('active'),
  tier: z.string().optional(),
  minRating: z.coerce.number().min(0).max(5).default(0),
  sortBy: z.enum(['rating', 'created']).default('rating'),
});
export type SpasListQuery = z.infer<typeof SpasListQuerySchema>;
