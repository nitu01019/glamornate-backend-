/**
 * GET /search/trending — curated trending searches. Strips `bookingCount`
 * from the public payload.
 */

import { Router, type Request, type Response } from 'express';
import { fetchTrendingSearches } from '../../data/trending-data-source';
import { okResponse, type TrendingSearch } from '@glamornate/contracts';

export const searchTrendingRouter = Router();

searchTrendingRouter.get('/search/trending', async (_req: Request, res: Response) => {
  try {
    const trending = await fetchTrendingSearches();
    const publicTrending: TrendingSearch[] = trending.map((t) => {
      const { bookingCount, ...rest } = t;
      void bookingCount;
      return rest;
    });

    res
      .set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
      .json(okResponse(publicTrending));
  } catch {
    res.status(500).json({
      success: false,
      data: [],
      error: 'Trending searches unavailable. Please try again.',
    });
  }
});
