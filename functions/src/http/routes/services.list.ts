/**
 * GET /services — list services with filtering, search, sorting, pagination.
 * Port of the frontend `/api/v1/services` handler.
 */

import { Router, type Request, type Response } from 'express';
import { catalogServices } from '../../data/glamornate-catalog';
import type { HomeService } from '../../data/types';
import {
  ServicesListQuerySchema,
  type ServicesListQuery,
  okResponse,
  errResponse,
} from '../../shared/contracts';
import { validate, getValidated } from '../middleware/validate';

export const servicesListRouter = Router();

servicesListRouter.get(
  '/services',
  validate('query', ServicesListQuerySchema),
  (req: Request, res: Response) => {
    try {
      const q = getValidated<ServicesListQuery>(req, 'query');

      let filtered: HomeService[] = catalogServices.filter((s) => s.isActive);

      if (q.category) {
        filtered = filtered.filter((s) => s.categorySlug === q.category);
      }

      if (q.subcategory) {
        const subLower = q.subcategory.toLowerCase();
        filtered = filtered.filter(
          (s) => s.subcategory !== undefined && s.subcategory.toLowerCase() === subLower,
        );
      }

      if (q.search) {
        const term = q.search.toLowerCase();
        filtered = filtered.filter((s) => s.name.toLowerCase().includes(term));
      }

      const sorted = [...filtered];
      switch (q.sort) {
        case 'price_asc':
          sorted.sort((a, b) => a.basePrice - b.basePrice);
          break;
        case 'price_desc':
          sorted.sort((a, b) => b.basePrice - a.basePrice);
          break;
        case 'name_asc':
          sorted.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'rating_desc':
          sorted.sort((a, b) => b.rating - a.rating);
          break;
        default:
          break;
      }

      const total = sorted.length;
      const paginated = sorted.slice(q.offset, q.offset + q.limit);

      res
        .set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
        .json(
          okResponse(paginated, {
            meta: { total, limit: q.limit, offset: q.offset },
          }),
        );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to fetch services';
      res.status(500).json(errResponse(message));
    }
  },
);
