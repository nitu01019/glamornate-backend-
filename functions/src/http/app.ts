/**
 * Glamornate HTTP API — Express application wrapped by a single v2 HTTPS
 * Cloud Function (`api`). Mounts the `/api/v1` router so the wire shape
 * matches the frontend Next.js routes 1:1.
 *
 * Middleware order (enforced):
 *   cors  →  verifyAppCheck  →  rateLimit  →  (verifyAuth on auth routes)
 *         →  validate         →  handler
 */

import { randomUUID } from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import { corsMiddleware } from './middleware/cors';
import { verifyAppCheck } from './middleware/appCheck';
import { publicRateLimit, authedRateLimit } from './middleware/rateLimit';
import { errResponse, okResponse } from '@glamornate/contracts';

import { categoriesRouter } from './routes/services.categories';
import { mostBookedRouter } from './routes/services.mostBooked';
import { servicesListRouter } from './routes/services.list';
import { serviceDetailRouter } from './routes/services.detail';
import { promotionsRouter } from './routes/promotions';
import { spasRouter } from './routes/spas';
import { bookingsRouter } from './routes/bookings';
import { searchRouter } from './routes/search';
import { searchTrendingRouter } from './routes/searchTrending';
import { searchSuggestionsRouter } from './routes/searchSuggestions';
import { cartRouter } from './routes/cart';

export interface BuildAppOptions {
  /**
   * When true (tests only), App Check and auth middleware are relaxed.
   */
  disableAppCheck?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));

  // CORS must run first so preflight OPTIONS responses don't hit any auth.
  app.use(corsMiddleware);
  app.options('*', corsMiddleware);

  // Health check — not subject to App Check so deploy verifications work.
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.json(okResponse({ status: 'ok', timestamp: new Date().toISOString() }));
  });

  const v1 = express.Router();

  v1.use(verifyAppCheck({ allowDebugBypass: options.disableAppCheck }));
  v1.use(publicRateLimit);

  // Public read routes
  v1.use(categoriesRouter);
  v1.use(mostBookedRouter);
  v1.use(servicesListRouter);
  v1.use(serviceDetailRouter);
  v1.use(promotionsRouter);
  v1.use(spasRouter);
  v1.use(searchRouter);
  v1.use(searchTrendingRouter);
  v1.use(searchSuggestionsRouter);
  // Cart preview/validate — read-only price lookup, no auth required.
  // Frontend posts here from `cart/page.tsx` before routing to /booking.
  v1.use(cartRouter);

  // Auth-required routes. Extra per-UID rate limit layered on top.
  v1.use(authedRateLimit((req) => req.auth?.uid));
  v1.use(bookingsRouter);

  app.use('/api/v1', v1);

  app.use((_req: Request, res: Response) => {
    res.status(404).json(errResponse('Not found'));
  });

  // Centralized error handler: must have 4 params to register as error handler.
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      const requestId = randomUUID();
      // Only log on the server; do not leak error details or stack traces to clients.
      // eslint-disable-next-line no-console
      console.error('[http] unhandled error:', { requestId, err });
      res.status(500).setHeader('X-Request-Id', requestId);
      res.json(errResponse('Internal server error'));
    },
  );

  return app;
}

const defaultApp = buildApp();
export default defaultApp;
