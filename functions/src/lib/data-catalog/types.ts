/**
 * Catalog types — structural definitions for the Glamornate service catalog.
 *
 * Historically duplicated between `frontend/src/lib/mock-data.ts` and
 * `backend/functions/src/data/types.ts`. Now the single source of truth:
 * both sides re-export these shapes for backward compatibility.
 */

export interface ServiceCategory {
  id: string;
  name: string;
  slug: string;
  image: string;
  serviceCount: number;
  badge?: string;
  ordering: number;
}

export interface HomeService {
  id: string;
  name: string;
  slug: string;
  category: string;
  categorySlug: string;
  subcategory?: string;
  description: string;
  benefits: string[];
  basePrice: number;
  originalPrice?: number;
  discountPercent?: number;
  currency: string;
  duration: string;
  durationMinutes: number;
  image: string;
  images: string[];
  isLandscapeImage?: boolean;
  rating: number;
  reviewCount: number;
  tags: string[];
  bookingCount: number;
  cities: string[];
  recommendedFor: 'all' | 'men' | 'women';
  isActive: boolean;
  createdAt: string;
}

export type DiscountType = 'percentage' | 'flat';

export interface Promotion {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  ctaText: string;
  ctaLink: string;
  bgColor: string;
  ordering: number;
  isActive: boolean;
  discountType?: DiscountType;
  discountValue?: number;
  promoCode?: string;
  validUntil?: string;
}
