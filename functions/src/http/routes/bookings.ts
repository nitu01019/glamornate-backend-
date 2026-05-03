/**
 * Booking routes.
 *
 * - POST /bookings         — create a booking draft for the authenticated user.
 * - GET  /bookings         — list bookings the caller owns (paginated).
 * - GET  /bookings/:id     — fetch a booking the caller owns or administers.
 *
 * Authorization rules for GET /bookings/:id:
 *   - booking.userId === req.auth.uid  → allow (customer)
 *   - booking.spaOwnerId === req.auth.uid → allow (spa owner of record)
 *   - otherwise → 403 Forbidden (NOT 404 — we must not leak existence).
 */

import { Router, type Request, type Response } from 'express';
import * as admin from 'firebase-admin';
import {
  BookingRequestSchema,
  type BookingRequest,
  okResponse,
  errResponse,
} from '../../lib/contracts';
import { z } from 'zod';
import { verifyAuth } from '../middleware/auth';
import { validate, getValidated } from '../middleware/validate';

export const bookingsRouter = Router();

const BookingsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
type BookingsListQuery = z.infer<typeof BookingsListQuerySchema>;

type BookingDoc = Record<string, unknown> & { id: string };

function toBookingDoc(
  snap: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): BookingDoc {
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return { ...data, id: snap.id };
}

function isAuthorizedToRead(
  booking: Record<string, unknown>,
  uid: string,
): boolean {
  const customerId = booking['userId'] ?? booking['customerId'];
  const spaOwnerId = booking['spaOwnerId'];
  return customerId === uid || spaOwnerId === uid;
}

bookingsRouter.post(
  '/bookings',
  verifyAuth(),
  validate('body', BookingRequestSchema),
  (req: Request, res: Response) => {
    const uid = req.auth?.uid;
    if (!uid) {
      res.status(401).json(errResponse('Authentication required'));
      return;
    }

    const body = getValidated<BookingRequest>(req, 'body');

    const now = new Date().toISOString();
    const bookingId = `booking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    res.status(201).json(
      okResponse({
        id: bookingId,
        userId: uid,
        bookingStatus: 'draft',
        services: body.services,
        date: body.date,
        timeSlot: body.timeSlot,
        location: body.location,
        address: body.address,
        notes: body.notes,
        createdAt: now,
        updatedAt: now,
      }),
    );
  },
);

bookingsRouter.get(
  '/bookings',
  verifyAuth(),
  validate('query', BookingsListQuerySchema),
  async (req: Request, res: Response) => {
    const uid = req.auth?.uid;
    if (!uid) {
      res.status(401).json(errResponse('Authentication required'));
      return;
    }

    try {
      const q = getValidated<BookingsListQuery>(req, 'query');
      const db = admin.firestore();

      // Fetch limit + 1 so we can compute hasMore without a count query.
      const snapshot = await db
        .collection('bookings')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .offset(q.offset)
        .limit(q.limit + 1)
        .get();

      const docs = snapshot.docs;
      const hasMore = docs.length > q.limit;
      const pageDocs = hasMore ? docs.slice(0, q.limit) : docs;
      const bookings = pageDocs.map(toBookingDoc);

      res.json(
        okResponse(bookings, {
          meta: {
            total: bookings.length,
            page: Math.floor(q.offset / q.limit) + 1,
            limit: q.limit,
            offset: q.offset,
          },
        }),
      );
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error('[bookings] list error:', error);
      const message = error instanceof Error ? error.message : 'Failed to fetch bookings';
      res.status(500).json(errResponse(message));
    }
  },
);

bookingsRouter.get(
  '/bookings/:id',
  verifyAuth(),
  async (req: Request, res: Response) => {
    const uid = req.auth?.uid;
    if (!uid) {
      res.status(401).json(errResponse('Authentication required'));
      return;
    }

    const id = typeof req.params.id === 'string' ? req.params.id : undefined;
    if (!id) {
      res.status(400).json(errResponse('Booking ID is required'));
      return;
    }

    try {
      const db = admin.firestore();
      const snap = await db.collection('bookings').doc(id).get();

      if (!snap.exists) {
        res.status(404).json(errResponse('Booking not found'));
        return;
      }

      const data = (snap.data() ?? {}) as Record<string, unknown>;

      if (!isAuthorizedToRead(data, uid)) {
        // Return 403 (NOT 404) so we do not conflate unauthorized access
        // with non-existence. Reviewer flagged this explicitly.
        res.status(403).json(errResponse('Forbidden'));
        return;
      }

      res.json(okResponse(toBookingDoc(snap)));
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error('[bookings] detail error:', error);
      const message = error instanceof Error ? error.message : 'Failed to fetch booking';
      res.status(500).json(errResponse(message));
    }
  },
);
