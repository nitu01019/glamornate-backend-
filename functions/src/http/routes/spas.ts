/**
 * GET /spas and GET /spas/:id — spa directory endpoints.
 *
 * Reads live from the Firestore `spas` collection. Public routes are
 * gated by App Check + rate-limit upstream in `http/app.ts`.
 */

import { Router, type Request, type Response } from 'express';
import * as admin from 'firebase-admin';
import {
  SpasListQuerySchema,
  type SpasListQuery,
  okResponse,
  errResponse,
} from '../../shared/contracts';
import { validate, getValidated } from '../middleware/validate';

export const spasRouter = Router();

const SERVICES_PER_SPA_LIMIT = 50;

type SpaDoc = Record<string, unknown> & { id: string };

function toSpaDoc(
  snap: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): SpaDoc {
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return { ...data, id: snap.id };
}

spasRouter.get(
  '/spas',
  validate('query', SpasListQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const q = getValidated<SpasListQuery>(req, 'query');
      const db = admin.firestore();

      // Base query: active spas ordered for deterministic pagination.
      // Composite index: (status asc, city asc, featuredRank asc) for city filter,
      // (status asc, featuredRank asc) for the unfiltered fallback.
      let query: FirebaseFirestore.Query = db
        .collection('spas')
        .where('status', '==', q.status || 'active');

      if (q.city) {
        query = query.where('city', '==', q.city);
      }

      query = query.orderBy('featuredRank', 'asc').orderBy('name', 'asc');

      // Cursor pagination using a stable string cursor. `after` is the last
      // document's `featuredRank|name` pair encoded via Firestore doc ref.
      if (q.after) {
        try {
          const afterSnap = await db.collection('spas').doc(q.after).get();
          if (afterSnap.exists) {
            query = query.startAfter(afterSnap);
          }
        } catch {
          // Ignore malformed cursor; start from beginning.
        }
      }

      // Fetch limit + 1 so we can compute hasMore without a second query.
      const snapshot = await query.limit(q.limit + 1).get();
      const docs = snapshot.docs;
      const hasMore = docs.length > q.limit;
      const pageDocs = hasMore ? docs.slice(0, q.limit) : docs;
      const spas = pageDocs.map(toSpaDoc);
      const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null;

      res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120').json(
        okResponse({
          spas,
          pagination: {
            limit: q.limit,
            hasMore,
            nextCursor,
          },
          filters: {
            city: q.city ?? null,
            category: q.category ?? null,
            status: q.status ?? 'active',
            tier: q.tier ?? null,
            minRating: q.minRating,
            sortBy: q.sortBy,
          },
        }),
      );
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error('[spas] list error:', error);
      const message = error instanceof Error ? error.message : 'Failed to fetch spas';
      res.status(500).json(errResponse(message));
    }
  },
);

spasRouter.get('/spas/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || typeof id !== 'string') {
    res.status(400).json(errResponse('Spa ID is required'));
    return;
  }

  try {
    const db = admin.firestore();
    const spaRef = db.collection('spas').doc(id);
    const [spaSnap, servicesSnap] = await Promise.all([
      spaRef.get(),
      spaRef.collection('services').limit(SERVICES_PER_SPA_LIMIT).get(),
    ]);

    if (!spaSnap.exists) {
      res.status(404).json(errResponse('Spa not found'));
      return;
    }

    const spa = toSpaDoc(spaSnap);
    const services = servicesSnap.docs.map((doc) => ({
      ...(doc.data() as Record<string, unknown>),
      id: doc.id,
    }));

    res
      .set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
      .json(okResponse({ ...spa, services }));
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error('[spas] detail error:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch spa';
    res.status(500).json(errResponse(message));
  }
});
