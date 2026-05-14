/**
 * GET /services/most-booked — 1:1 port of the frontend route.
 * Includes a `fallbackLevel` hint when the result set had to be broadened.
 */

import { Router, type Request, type Response } from 'express';
import { catalogServices } from '../../data/glamornate-catalog';
import type { HomeService } from '../../data/types';
import {
  MostBookedQuerySchema,
  okResponse,
  errResponse,
  type FallbackLevel,
} from '../../shared/contracts';
import { validate, getValidated } from '../middleware/validate';

export const mostBookedRouter = Router();

mostBookedRouter.get(
  '/services/most-booked',
  validate('query', MostBookedQuerySchema),
  (req: Request, res: Response) => {
    try {
      const query = getValidated<{ category?: string; limit: number }>(req, 'query');

      const active: HomeService[] = catalogServices.filter((s) => s.isActive);

      let pool: HomeService[] = active;
      let fallbackLevel: FallbackLevel | undefined;

      if (query.category) {
        const filtered = active.filter((s) => s.categorySlug === query.category);
        if (filtered.length === 0) {
          pool = active;
          fallbackLevel = 'platform';
        } else {
          pool = filtered;
        }
      }

      const sorted = [...pool].sort((a, b) => b.bookingCount - a.bookingCount);
      const results = sorted.slice(0, query.limit);

      res
        .set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
        .json(
          okResponse(results, {
            meta: { total: results.length },
            fallbackLevel,
          }),
        );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch most booked services';
      res.status(500).json(errResponse(message));
    }
  },
);
