import { z } from 'zod';
import { apiResponseSchema, FallbackLevelSchema } from './envelope';

export const HomeServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  category: z.string(),
  categorySlug: z.string(),
  subcategory: z.string().optional(),
  description: z.string(),
  benefits: z.array(z.string()),
  basePrice: z.number().nonnegative(),
  originalPrice: z.number().nonnegative().optional(),
  discountPercent: z.number().nonnegative().optional(),
  currency: z.string(),
  duration: z.string(),
  durationMinutes: z.number().int().nonnegative(),
  image: z.string(),
  images: z.array(z.string()),
  isLandscapeImage: z.boolean().optional(),
  rating: z.number().min(0).max(5),
  reviewCount: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  bookingCount: z.number().int().nonnegative(),
  cities: z.array(z.string()),
  recommendedFor: z.enum(['all', 'men', 'women']),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type HomeService = z.infer<typeof HomeServiceSchema>;

// GET /services - list response (paginated)
export const ServicesListResponseSchema = apiResponseSchema(z.array(HomeServiceSchema));
export type ServicesListResponse = z.infer<typeof ServicesListResponseSchema>;

// GET /services/:id - single response
export const ServiceDetailResponseSchema = apiResponseSchema(HomeServiceSchema);
export type ServiceDetailResponse = z.infer<typeof ServiceDetailResponseSchema>;

// GET /services/most-booked
export const MostBookedResponseSchema = apiResponseSchema(z.array(HomeServiceSchema)).extend({
  fallbackLevel: FallbackLevelSchema.optional(),
});
export type MostBookedResponse = z.infer<typeof MostBookedResponseSchema>;

// Query schemas
export const ServicesListQuerySchema = z.object({
  category: z.string().optional(),
  subcategory: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(['price_asc', 'price_desc', 'name_asc', 'rating_desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ServicesListQuery = z.infer<typeof ServicesListQuerySchema>;

export const MostBookedQuerySchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type MostBookedQuery = z.infer<typeof MostBookedQuerySchema>;
