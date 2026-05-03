/**
 * Promotional banners — ported read-only from the frontend mock-data module.
 * Keep shape in lock-step with `@glamornate/contracts` `PromotionSchema`.
 */

import type { Promotion } from './types';

export const promotions: Promotion[] = [
  {
    id: 'promo-01',
    title: 'HydraGlo Facial',
    subtitle: 'Time to Upgrade Your Facial Experience',
    description:
      'Deep Hydration with HydraGlo Facial -- advanced hydrafacial technology for glowing, youthful skin.',
    image: '/images/promotions/hydraglo-banner.webp',
    ctaText: 'Book Now',
    ctaLink: '/services?category=hydraglo-facials',
    bgColor: '#E8F5E9',
    ordering: 1,
    isActive: true,
    discountType: 'percentage',
    discountValue: 30,
    promoCode: 'HYDRA30',
    validUntil: '2026-05-31T23:59:59Z',
  },
  {
    id: 'promo-02',
    title: 'Full Body Korean Spa Ritual',
    subtitle: "India's 1st Ever Full Body Korean Spa Ritual",
    description:
      "India's 1st Ever Full Body Korean Spa Ritual with sensory healing techniques & 8 free gifts. A luxurious head-to-toe Korean spa experience.",
    image: '/images/promotions/korean-spa-banner.webp',
    ctaText: 'Explore',
    ctaLink: '/services?category=spa-for-women',
    bgColor: '#FFF3E0',
    ordering: 2,
    isActive: true,
    discountType: 'flat',
    discountValue: 500,
    promoCode: 'KOREAN500',
    validUntil: '2026-06-15T23:59:59Z',
  },
  {
    id: 'promo-03',
    title: 'Bridal Season Special',
    subtitle: 'Get Wedding Ready with Glamornate',
    description:
      'Complete bridal packages starting at Rs 4,999. Book 2 sessions, get 3rd free. Limited period offer.',
    image: '/images/promotions/bridal-banner.webp',
    ctaText: 'View Packages',
    ctaLink: '/services?category=pre-bridal-packages',
    bgColor: '#FCE4EC',
    ordering: 3,
    isActive: true,
    discountType: 'percentage',
    discountValue: 25,
    promoCode: 'BRIDAL25',
    validUntil: '2026-07-31T23:59:59Z',
  },
  {
    id: 'promo-04',
    title: 'Summer Glow Package',
    subtitle: 'Beat the Heat with Premium Care',
    description:
      'Get a full body de-tan, facial, and hair spa combo at an unbeatable price. Perfect for the summer season.',
    image: '/images/promotions/summer-glow-banner.webp',
    ctaText: 'Book Now',
    ctaLink: '/services?category=spa-for-women',
    bgColor: '#FFF8E1',
    ordering: 4,
    isActive: true,
    discountType: 'flat',
    discountValue: 200,
    promoCode: 'SUMMER200',
    validUntil: '2026-06-30T23:59:59Z',
  },
];
