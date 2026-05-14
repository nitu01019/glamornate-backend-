/**
 * GET /promotions — active promotional banners sorted by `ordering`.
 */

import { Router, type Request, type Response } from 'express';
import { promotions } from '../../data/promotions';
import { okResponse, errResponse } from '../../shared/contracts';

export const promotionsRouter = Router();

promotionsRouter.get('/promotions', (_req: Request, res: Response) => {
  try {
    const active = promotions.filter((p) => p.isActive).sort((a, b) => a.ordering - b.ordering);

    res
      .set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
      .json(
        okResponse(active, {
          meta: { total: active.length, page: 1, limit: active.length },
        }),
      );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch promotions';
    res.status(500).json(errResponse(message));
  }
});
