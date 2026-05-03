/**
 * Trending searches data source (ported from frontend).
 * Derives a ranked list of popular service categories and brand-name services
 * from the in-memory catalog. The public response strips `bookingCount`.
 */

import type { SpaCategory } from '@glamornate/contracts';
import { catalogData, catalogServices } from './glamornate-catalog';

export interface TrendingSearchInternal {
  label: string;
  query: string;
  category: SpaCategory;
  icon: string;
  bookingCount: number;
}

const CATEGORY_META: Record<string, { spaCategory: SpaCategory; icon: string }> = {
  facials: { spaCategory: 'facial', icon: 'sparkles' },
  'clean-ups': { spaCategory: 'facial', icon: 'user' },
  waxing: { spaCategory: 'body', icon: 'flower2' },
  'manicure-pedicure': { spaCategory: 'manicure', icon: 'hand' },
  bleach: { spaCategory: 'body', icon: 'gem' },
  'de-tan-pack': { spaCategory: 'body', icon: 'star' },
  threading: { spaCategory: 'body', icon: 'scissors' },
  'body-polishing-massage': { spaCategory: 'massage', icon: 'activity' },
  'hair-root-touch-up': { spaCategory: 'body', icon: 'crown' },
  'global-hair-coloring': { spaCategory: 'body', icon: 'crown' },
  'hair-spa': { spaCategory: 'wellness', icon: 'heart' },
  'hair-transformation': { spaCategory: 'body', icon: 'scissors' },
  'hair-treatments': { spaCategory: 'wellness', icon: 'heart' },
};

function buildTrendingFromCatalog(): TrendingSearchInternal[] {
  const categoryTrending: TrendingSearchInternal[] = catalogData
    .map((cat) => {
      const meta = CATEGORY_META[cat.slug] ?? {
        spaCategory: 'body' as SpaCategory,
        icon: 'sparkles',
      };
      const totalBookings = catalogServices
        .filter((s) => s.categorySlug === cat.slug)
        .reduce((sum, s) => sum + s.bookingCount, 0);

      return {
        label: cat.name,
        query: cat.name.toLowerCase(),
        category: meta.spaCategory,
        icon: meta.icon,
        bookingCount: totalBookings,
      };
    })
    .sort((a, b) => b.bookingCount - a.bookingCount)
    .slice(0, 8);

  const POPULAR_SERVICES: Array<{
    label: string;
    query: string;
    category: SpaCategory;
    icon: string;
  }> = [
    { label: 'Korean Wax', query: 'korean wax', category: 'body', icon: 'flower2' },
    { label: 'O3+ Facial', query: 'o3+ facial', category: 'facial', icon: 'sparkles' },
    { label: 'Rica Wax', query: 'rica wax', category: 'body', icon: 'flower2' },
    { label: 'Keratin Treatment', query: 'keratin treatment', category: 'wellness', icon: 'heart' },
    { label: 'Full Body Massage', query: 'full body massage', category: 'massage', icon: 'activity' },
    { label: 'Bridal Facial', query: 'bridal facial', category: 'facial', icon: 'crown' },
  ];

  const serviceTrending: TrendingSearchInternal[] = POPULAR_SERVICES.map((svc) => {
    const matchingBookings = catalogServices
      .filter((s) => s.name.toLowerCase().includes(svc.query))
      .reduce((sum, s) => sum + s.bookingCount, 0);

    return {
      ...svc,
      bookingCount: matchingBookings || 500,
    };
  });

  const seen = new Set<string>();
  const combined: TrendingSearchInternal[] = [];

  for (const item of [...categoryTrending, ...serviceTrending]) {
    if (!seen.has(item.query)) {
      seen.add(item.query);
      combined.push(item);
    }
    if (combined.length >= 12) break;
  }

  return combined;
}

const CATALOG_TRENDING = buildTrendingFromCatalog();

export async function fetchTrendingSearches(): Promise<TrendingSearchInternal[]> {
  return CATALOG_TRENDING;
}
