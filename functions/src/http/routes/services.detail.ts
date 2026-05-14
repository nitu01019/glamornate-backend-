/**
 * GET /services/:id — single service lookup by id or slug.
 */

import { Router, type Request, type Response } from 'express';
import { catalogServices, getServiceById } from '../../data/glamornate-catalog';
import { okResponse, errResponse } from '../../shared/contracts';

export const serviceDetailRouter = Router();

serviceDetailRouter.get('/services/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id || typeof id !== 'string') {
      res.status(400).json(errResponse('Service ID is required'));
      return;
    }

    const service = getServiceById(id) ?? catalogServices.find((s) => s.slug === id);

    if (!service) {
      res.status(404).json(errResponse('Not found'));
      return;
    }

    res.json(okResponse(service));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch service';
    res.status(500).json(errResponse(message));
  }
});
