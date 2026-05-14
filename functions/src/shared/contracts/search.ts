import { z } from 'zod';
import { apiResponseSchema } from './envelope';
import {
  SpaCategorySchema,
  SearchSortBySchema,
  RatingSchema,
  PublicLocationSchema,
} from './primitives';

export const UnifiedSearchResultSchema = z.object({
  type: z.enum(['service', 'spa']),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: SpaCategorySchema,
  imageUrl: z.string().optional(),
  rating: RatingSchema,
  price: z.number().optional(),
  duration: z.number().optional(),
  tags: z.array(z.string()).optional(),
  spaName: z.string().optional(),
  spaId: z.string().optional(),
  location: PublicLocationSchema.optional(),
});
export type UnifiedSearchResult = z.infer<typeof UnifiedSearchResultSchema>;

export const TrendingSearchSchema = z.object({
  label: z.string(),
  query: z.string(),
  category: SpaCategorySchema,
  icon: z.string(),
});
export type TrendingSearch = z.infer<typeof TrendingSearchSchema>;

export const SearchResponseSchema = apiResponseSchema(z.array(UnifiedSearchResultSchema));
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const TrendingResponseSchema = apiResponseSchema(z.array(TrendingSearchSchema));
export type TrendingResponse = z.infer<typeof TrendingResponseSchema>;

export const SuggestionResponseSchema = apiResponseSchema(z.array(z.string()));
export type SuggestionResponse = z.infer<typeof SuggestionResponseSchema>;

export const SearchQuerySchema = z.object({
  q: z.string().max(100).default(''),
  category: z.string().optional(),
  sort: SearchSortBySchema.default('relevance'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SuggestionQuerySchema = z.object({
  q: z.string().max(100).default(''),
});
export type SuggestionQuery = z.infer<typeof SuggestionQuerySchema>;
