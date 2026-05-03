import { z } from 'zod';

export const SpaCategorySchema = z.enum([
  'massage',
  'facial',
  'body',
  'pedicure',
  'manicure',
  'wellness',
]);
export type SpaCategory = z.infer<typeof SpaCategorySchema>;

export const SearchSortBySchema = z.enum([
  'relevance',
  'rating',
  'price_low',
  'price_high',
  'newest',
]);
export type SearchSortBy = z.infer<typeof SearchSortBySchema>;

export const PriceRangeSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
});
export type PriceRange = z.infer<typeof PriceRangeSchema>;

/**
 * Rating carries both the overall headline score and an optional per-aspect
 * breakdown that the frontend reads on spa and therapist detail pages.
 *
 * The public wire shape (served by `/spas/:id`) may omit `breakdown` entirely,
 * so it stays optional in the contract. Frontend consumers guard on presence.
 */
export const RatingBreakdownSchema = z.object({
  ambiance: z.number().min(0).max(5),
  service: z.number().min(0).max(5),
  hygiene: z.number().min(0).max(5),
  therapist: z.number().min(0).max(5),
});
export type RatingBreakdown = z.infer<typeof RatingBreakdownSchema>;

export const RatingSchema = z.object({
  overall: z.number().min(0).max(5),
  count: z.number().int().nonnegative(),
  breakdown: RatingBreakdownSchema.optional(),
});
export type Rating = z.infer<typeof RatingSchema>;

/**
 * Location is the Firestore `spas/{id}.location` subshape. The canonical
 * document shape requires every field (populated at spa-registration time).
 *
 * The public wire DTO (see `PublicLocationSchema`) leaves every field
 * optional — callers that build the schema from a partial/legacy doc should
 * use the Public variant to stay backwards compatible.
 */
export const GeoSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type Geo = z.infer<typeof GeoSchema>;

export const LocationSchema = z.object({
  address: z.string(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
  geo: GeoSchema,
  timezone: z.string(),
});
export type Location = z.infer<typeof LocationSchema>;

/**
 * Loose wire-level Location variant used by public endpoints that may emit
 * partial data (e.g. legacy spa docs predating the strict Firestore schema).
 * Kept structurally compatible with the previous Category-B contract.
 */
export const PublicLocationSchema = z.object({
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  geo: GeoSchema.optional(),
  timezone: z.string().optional(),
});
export type PublicLocation = z.infer<typeof PublicLocationSchema>;
