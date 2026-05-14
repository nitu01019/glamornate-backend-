/**
 * Search data source (ported from the frontend lib).
 * Backed by the in-memory `catalogServices` catalog; can be swapped for a
 * Firestore-backed implementation without changing callers.
 */

import { catalogServices } from './glamornate-catalog';
import type { HomeService } from './types';
import { computeRelevanceScore, fuzzyMatch, levenshteinDistance } from './search-scoring';
import type { SpaCategory, SearchSortBy } from '../shared/contracts';

// Map catalog categorySlug -> SpaCategory union used by the public API filter bar.
const SLUG_TO_CATEGORY: Record<string, SpaCategory> = {
  facials: 'facial',
  'clean-ups': 'facial',
  waxing: 'body',
  'manicure-pedicure': 'manicure',
  bleach: 'body',
  'de-tan-pack': 'body',
  threading: 'body',
  'body-polishing-massage': 'massage',
  'hair-root-touch-up': 'body',
  'global-hair-coloring': 'body',
  'hair-spa': 'wellness',
  'hair-transformation': 'wellness',
  'hair-treatments': 'wellness',
};

export interface InternalSearchResult {
  type: 'service';
  id: string;
  name: string;
  description: string;
  category: SpaCategory;
  imageUrl?: string;
  rating: { overall: number; count: number };
  price?: number;
  duration?: number;
  tags?: string[];
  relevanceScore: number;
}

function mapServiceToResult(service: HomeService): InternalSearchResult {
  return {
    type: 'service',
    id: service.id,
    name: service.name,
    description: service.description,
    category: (SLUG_TO_CATEGORY[service.categorySlug] ?? 'body') as SpaCategory,
    imageUrl: service.image,
    rating: { overall: service.rating, count: service.reviewCount },
    price: service.basePrice,
    duration: service.durationMinutes,
    tags: service.tags,
    relevanceScore: 0,
  };
}

export interface SearchParams {
  query: string;
  category: SpaCategory | null;
  sort: SearchSortBy;
  limit: number;
  offset: number;
}

export interface SearchDataResult {
  results: InternalSearchResult[];
  total: number;
  didYouMean?: string;
}

function computeDidYouMean(query: string, pool: HomeService[]): string | undefined {
  const q = query.toLowerCase().trim();
  let bestWord: string | undefined;
  let bestDistance = Infinity;

  for (const service of pool) {
    const searchableText = [service.name, service.category, service.subcategory ?? ''].join(' ');
    const words = searchableText.toLowerCase().split(/\s+/).filter(Boolean);
    for (const word of words) {
      const dist = levenshteinDistance(q, word);
      if (dist < bestDistance && dist > 0) {
        bestDistance = dist;
        bestWord = word;
      }
    }
  }

  const threshold = q.length <= 4 ? 1 : q.length <= 7 ? 2 : 3;
  if (bestWord && bestDistance <= threshold) {
    return bestWord;
  }
  return undefined;
}

function exactFilter(pool: HomeService[], query: string): HomeService[] {
  const q = query.toLowerCase();
  return pool.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      (s.subcategory?.toLowerCase().includes(q) ?? false) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

function fuzzyFilter(pool: HomeService[], query: string): HomeService[] {
  const q = query.toLowerCase();
  return pool.filter(
    (s) =>
      fuzzyMatch(q, s.name.toLowerCase()) ||
      fuzzyMatch(q, s.category.toLowerCase()) ||
      (s.subcategory ? fuzzyMatch(q, s.subcategory.toLowerCase()) : false) ||
      fuzzyMatch(q, s.description.toLowerCase()) ||
      s.tags.some((t) => fuzzyMatch(q, t.toLowerCase())),
  );
}

export async function fetchSearchResults(params: SearchParams): Promise<SearchDataResult> {
  const { query, category, sort, limit, offset } = params;

  let pool: HomeService[] = catalogServices.filter((s) => s.isActive);

  if (category) {
    pool = pool.filter((s) => SLUG_TO_CATEGORY[s.categorySlug] === category);
  }

  let filtered: HomeService[];
  let didYouMean: string | undefined;

  if (query.length >= 2) {
    filtered = exactFilter(pool, query);
    if (filtered.length === 0) {
      filtered = fuzzyFilter(pool, query);
      if (filtered.length > 0) {
        didYouMean = computeDidYouMean(query, filtered);
      }
    }
  } else {
    filtered = pool;
  }

  const results: InternalSearchResult[] = filtered.map((s) => {
    const base = mapServiceToResult(s);
    const searchIndex = [s.name, s.category, s.subcategory ?? '', ...s.tags, ...s.benefits]
      .join(' ')
      .toLowerCase();
    const relevanceScore = query
      ? computeRelevanceScore(query, {
          name: s.name,
          description: s.description,
          tags: s.tags,
          searchIndex,
          rating: s.rating,
          bookingCount: s.bookingCount,
        })
      : 0;
    return { ...base, relevanceScore };
  });

  switch (sort) {
    case 'price_low':
      results.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
      break;
    case 'price_high':
      results.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
      break;
    case 'rating':
      results.sort((a, b) => b.rating.overall - a.rating.overall);
      break;
    case 'newest':
      results.sort((a, b) => b.id.localeCompare(a.id));
      break;
    case 'relevance':
    default:
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);
      break;
  }

  const total = results.length;
  const paginated = results.slice(offset, offset + limit);

  return { results: paginated, total, didYouMean };
}
