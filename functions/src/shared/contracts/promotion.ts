import { z } from 'zod';
import { apiResponseSchema } from './envelope';

export const DiscountTypeSchema = z.enum(['percentage', 'flat', 'fixed_price']);
export type DiscountType = z.infer<typeof DiscountTypeSchema>;

export const PromotionSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  description: z.string(),
  image: z.string(),
  ctaText: z.string(),
  ctaLink: z.string(),
  bgColor: z.string(),
  ordering: z.number().int(),
  isActive: z.boolean(),
  discountType: DiscountTypeSchema.optional(),
  discountValue: z.number().optional(),
  promoCode: z.string().optional(),
  validUntil: z.string().optional(),
});
export type Promotion = z.infer<typeof PromotionSchema>;

export const PromotionsResponseSchema = apiResponseSchema(z.array(PromotionSchema));
export type PromotionsResponse = z.infer<typeof PromotionsResponseSchema>;
