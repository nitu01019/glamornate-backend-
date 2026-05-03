import { z } from 'zod';
import { apiResponseSchema, MetaSchema } from './envelope';
import { PriceRangeSchema } from './primitives';

export const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional().default(''),
  image: z.string(),
  serviceCount: z.number().int().nonnegative(),
  priceRange: PriceRangeSchema,
  ordering: z.number().int(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoriesResponseSchema = apiResponseSchema(z.array(CategorySchema));
export type CategoriesResponse = z.infer<typeof CategoriesResponseSchema>;

export { MetaSchema };
