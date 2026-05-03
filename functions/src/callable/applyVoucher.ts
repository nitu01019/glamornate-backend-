import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';

/**
 * applyVoucher — customer-facing callable.
 *
 * Phase 9B (Booking Flow Fix v3.1, 2026-05-02): customers used to be
 * able to write `voucherCode` directly on their booking via Firestore
 * rules; that permitted privilege escalation (mark a booking as
 * voucher-redeemed without the server validating the code). The rules
 * now reject that field on customer create/update; this callable is the
 * sanctioned write path.
 *
 * Validates the voucher against `vouchers/{code}` (case-insensitive),
 * confirms the booking is owned by the caller and still active, and
 * atomically:
 *   - sets booking.voucherCode + booking.pricing.discount
 *   - increments voucher.redeemedCount
 *   - writes a redemption sub-doc for audit
 *
 * Rate-limited at 10 / 60s per user. Audit-logged. Idempotent: applying
 * the same voucher twice on the same booking is a no-op (returns the
 * already-applied state without incrementing counts).
 */
const db = admin.firestore();
const logger = createLogger('applyVoucher');

const ApplyVoucherSchema = z.object({
  bookingId: z.string().min(1),
  code: z.string().min(2).max(40),
});

type ApplyVoucherInput = z.infer<typeof ApplyVoucherSchema>;

export const applyVoucher = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'applyVoucher', windowMs: 60_000, max: 10 },
    async (data, context) => {
      if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
      }
      const userId = context.auth.uid;

      let validated: ApplyVoucherInput;
      try {
        validated = ApplyVoucherSchema.parse(data);
      } catch (err) {
        throw handleError(err);
      }

      const code = validated.code.trim().toUpperCase();
      const voucherRef = db.collection('vouchers').doc(code);
      const bookingRef = db.collection('bookings').doc(validated.bookingId);

      try {
        const result = await db.runTransaction(async (txn) => {
          const [bookingSnap, voucherSnap] = await Promise.all([
            txn.get(bookingRef),
            txn.get(voucherRef),
          ]);

          if (!bookingSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'Booking not found.', {
              error: 'BOOKING_NOT_FOUND',
            });
          }
          const booking = bookingSnap.data()!;

          if (booking.userId !== userId) {
            throw new functions.https.HttpsError(
              'permission-denied',
              'Not authorized for this booking.',
            );
          }

          if (booking.bookingStatus !== 'confirmed') {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'Vouchers can only be applied to confirmed bookings.',
              { error: 'BOOKING_NOT_VOUCHER_ELIGIBLE' },
            );
          }

          if (booking.voucherCode === code) {
            // Idempotent re-apply.
            return {
              success: true,
              voucherCode: code,
              discount: booking.pricing?.discount ?? 0,
              alreadyApplied: true,
            };
          }

          if (!voucherSnap.exists) {
            throw new functions.https.HttpsError(
              'not-found',
              'Voucher code not recognised.',
              { error: 'VOUCHER_NOT_FOUND' },
            );
          }
          const voucher = voucherSnap.data()!;

          if (voucher.isActive === false) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This voucher is no longer active.',
              { error: 'VOUCHER_INACTIVE' },
            );
          }
          const nowMs = Date.now();
          const expiresAtMs =
            (voucher.expiresAt?.toMillis ? voucher.expiresAt.toMillis() : null) ?? null;
          if (expiresAtMs !== null && expiresAtMs < nowMs) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This voucher has expired.',
              { error: 'VOUCHER_EXPIRED' },
            );
          }
          if (
            typeof voucher.maxRedemptions === 'number' &&
            (voucher.redeemedCount ?? 0) >= voucher.maxRedemptions
          ) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This voucher has reached its redemption limit.',
              { error: 'VOUCHER_LIMIT_REACHED' },
            );
          }

          // Compute discount. Two shapes supported:
          //   - flat: { discountAmount: <INR int> }
          //   - percent: { discountPercent: <0-100>, maxDiscount?: <INR int> }
          const subtotal: number =
            (booking.pricing?.services ?? 0) + (booking.pricing?.addons ?? 0);
          let discount = 0;
          if (typeof voucher.discountAmount === 'number') {
            discount = Math.min(voucher.discountAmount, subtotal);
          } else if (typeof voucher.discountPercent === 'number') {
            discount = Math.round((subtotal * voucher.discountPercent) / 100);
            if (typeof voucher.maxDiscount === 'number') {
              discount = Math.min(discount, voucher.maxDiscount);
            }
          }
          discount = Math.max(0, Math.min(discount, subtotal));

          const newTotal =
            subtotal +
            (booking.pricing?.tax ?? 0) +
            (booking.pricing?.platformFee ?? 0) -
            discount;

          txn.update(bookingRef, {
            voucherCode: code,
            'pricing.discount': discount,
            'pricing.total': newTotal,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          txn.update(voucherRef, {
            redeemedCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          txn.set(voucherRef.collection('redemptions').doc(validated.bookingId), {
            userId,
            bookingId: validated.bookingId,
            discount,
            redeemedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return {
            success: true,
            voucherCode: code,
            discount,
            alreadyApplied: false,
          };
        });

        try {
          await writeAuditLog({
            userId,
            action: 'voucher.applied',
            entity: { type: 'booking', id: validated.bookingId },
            before: null,
            after: { voucherCode: code, discount: result.discount },
            metadata: { actor: 'customer' },
          });
        } catch (auditError) {
          logger.warn('writeAuditLog failed (applyVoucher)', auditError);
        }

        logger.info('Voucher applied', {
          userId, bookingId: validated.bookingId, code, discount: result.discount,
        });

        return result;
      } catch (error: unknown) {
        throw handleError(error);
      }
    },
  ),
);
