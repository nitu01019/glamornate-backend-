/**
 * GET /search — unified search across services.
 */

import { Router, type Request, type Response } from 'express';
import { fetchSearchResults } from '../../data/search-data-source';
import {
  SearchQuerySchema,
  type SearchQuery,
  SpaCategorySchema,
  okResponse,
  type SpaCategory,
  type UnifiedSearchResult,
} from '../../shared/contracts';
import { validate, getValidated } from '../middleware/validate';

export const searchRouter = Router();

const MAX_QUERY_LENGTH = 100;
// eslint-disable-next-line no-control-regex -- strip control characters from user input
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;

function sanitizeQuery(raw: string): string {
  return raw.slice(0, MAX_QUERY_LENGTH).trim().replace(CONTROL_CHAR_REGEX, '');
}

searchRouter.get('/search', validate('query', SearchQuerySchema), async (req: Request, res: Response) => {
  try {
    const q = getValidated<SearchQuery>(req, 'query');
    const query = sanitizeQuery(q.q);

    const categoryResult = q.category ? SpaCategorySchema.safeParse(q.category) : null;
    const category: SpaCategory | null = categoryResult?.success ? categoryResult.data : null;

    const { results, total, didYouMean } = await fetchSearchResults({
      query,
      category,
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    });

    const page = Math.floor(q.offset / q.limit) + 1;

    // Strip relevanceScore from the public payload.
    const publicResults: UnifiedSearchResult[] = results.map((r) => {
      const { relevanceScore, ...rest } = r;
      void relevanceScore;
      return rest as UnifiedSearchResult;
    });

    res
      .set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60')
      .json(
        okResponse(publicResults, {
          meta: { total, page, limit: q.limit },
          ...(didYouMean ? { didYouMean } : {}),
        }),
      );
  } catch {
    res.status(500).json({
      success: false,
      data: [],
      error: 'Search unavailable. Please try again.',
      meta: { total: 0, page: 1, limit: 20 },
    });
  }
});
