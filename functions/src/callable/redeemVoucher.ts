import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';

const db = admin.firestore();
const logger = createLogger('redeemVoucher');

const RedeemVoucherSchema = z.object({
  code: z.string().min(3).max(50),
  bookingId: z.string(),
});

type RedeemVoucherInput = z.infer<typeof RedeemVoucherSchema>;

export const redeemVoucher = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'redeemVoucher', windowMs: 60_000, max: 5 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated: RedeemVoucherInput = RedeemVoucherSchema.parse(data);

    // Get voucher
    const voucherSnapshot = await db
      .collection('vouchers')
      .where('code', '==', validated.code.toUpperCase())
      .where('isActive', '==', true)
      .get();

    if (voucherSnapshot.empty) {
      throw new functions.https.HttpsError('not-found', 'Invalid or expired voucher code');
    }

    const voucher = voucherSnapshot.docs[0].data();
    const voucherId = voucherSnapshot.docs[0].id;

    // Check validity dates
    const now = new Date();
    const validFrom = voucher.validFrom?.toDate();
    const validUntil = voucher.validUntil?.toDate();

    if (validFrom && now < validFrom) {
      throw new functions.https.HttpsError('failed-precondition', 'This voucher is not yet active');
    }

    if (validUntil && now > validUntil) {
      throw new functions.https.HttpsError('failed-precondition', 'This voucher has expired');
    }

    // Check user's remaining uses
    const compositeId = `${userId}_${voucherId}`;
    const userVoucherDoc = await db.collection('user_vouchers').doc(compositeId).get();

    let remainingUses: number;
    if (userVoucherDoc.exists) {
      const userVoucher = userVoucherDoc.data()!;
      if (userVoucher.remainingUses <= 0) {
        throw new functions.https.HttpsError('failed-precondition', 'You have already used this voucher');
      }
      remainingUses = userVoucher.remainingUses - 1;
    } else {
      remainingUses = (voucher.maxUses || 1) - 1;
    }

    // Pre-read the booking ONCE to validate ownership + state. The
    // authoritative pricing read, however, moves INSIDE the transaction so
    // a concurrent booking mutation between here and the commit cannot be
    // overwritten with stale totals (BE-M6).
    const bookingRef = db.collection('bookings').doc(validated.bookingId);
    const bookingPreRead = await bookingRef.get();

    if (!bookingPreRead.exists) {
      throw new functions.https.HttpsError('not-found', 'Booking not found');
    }

    const bookingPre = bookingPreRead.data()!;

    if (bookingPre.userId !== userId) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized for this booking');
    }

    if (bookingPre.bookingStatus !== 'draft') {
      throw new functions.https.HttpsError('failed-precondition', 'Voucher can only be applied to draft bookings');
    }

    // All four reads/writes (voucher read, booking read+write, user_vouchers
    // read+write, voucher usedCount increment) are performed inside a single
    // transaction. Pricing is recomputed from the transactional booking
    // snapshot, so a racing writer cannot be overwritten with stale totals.
    const voucherRef = voucherSnapshot.docs[0].ref;
    const userVoucherRef = db.collection('user_vouchers').doc(compositeId);
    const timestamp = admin.firestore.Timestamp.now();
    const TAX_RATE = Number(process.env.TAX_RATE_PERCENT ?? 18) / 100;
    const PLATFORM_FEE_RATE = Number(process.env.PLATFORM_FEE_PERCENT ?? 20) / 100;

    // Captured out of the transaction so the return payload can reference
    // the final values. The closure below assigns them on commit.
    let discountAmount = 0;
    let newTax = 0;
    let newPlatformFee = 0;
    let newTotal = 0;

    await db.runTransaction(async (transaction) => {
      // ---- 1. Re-read voucher (usageLimit) and booking (pricing) -----------
      const voucherDoc = await transaction.get(voucherRef);
      if (!voucherDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Voucher not found');
      }

      const currentVoucher = voucherDoc.data()!;
      if (currentVoucher.usageLimit && currentVoucher.usedCount >= currentVoucher.usageLimit) {
        throw new functions.https.HttpsError('failed-precondition', 'This voucher has reached its usage limit');
      }

      const bookingDoc = await transaction.get(bookingRef);
      if (!bookingDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Booking not found');
      }

      const booking = bookingDoc.data()!;

      // Ownership + state re-verified against the transactional snapshot.
      if (booking.userId !== userId) {
        throw new functions.https.HttpsError('permission-denied', 'Not authorized for this booking');
      }
      if (booking.bookingStatus !== 'draft') {
        throw new functions.https.HttpsError('failed-precondition', 'Voucher can only be applied to draft bookings');
      }

      // ---- 2. Min-order check & discount calc on transactional pricing -----
      const pricing = booking.pricing ?? { services: 0, addons: 0, total: 0 };
      if (voucher.minOrderAmount && pricing.total < voucher.minOrderAmount) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Minimum order amount for this voucher is ${voucher.minOrderAmount}`,
        );
      }

      let computedDiscount = 0;
      if (voucher.discountType === 'percentage') {
        computedDiscount = Math.round(pricing.services * (voucher.discountValue / 100));
      } else if (voucher.discountType === 'flat' || voucher.discountType === 'fixed_price') {
        computedDiscount = voucher.discountValue;
      } else if (voucher.discountType === 'free_service') {
        computedDiscount = pricing.services;
      }
      if (voucher.maxDiscountAmount && computedDiscount > voucher.maxDiscountAmount) {
        computedDiscount = voucher.maxDiscountAmount;
      }

      const discountedServices = Math.max(0, pricing.services - computedDiscount);
      const tax = Math.round(discountedServices * TAX_RATE);
      const platformFee = Math.round(discountedServices * PLATFORM_FEE_RATE);
      const total = discountedServices + (pricing.addons || 0) + tax + platformFee;

      discountAmount = computedDiscount;
      newTax = tax;
      newPlatformFee = platformFee;
      newTotal = total;

      // ---- 3. Writes (booking pricing, user_vouchers, voucher usedCount) ---
      transaction.update(bookingRef, {
        'pricing.discount': computedDiscount,
        'pricing.tax': tax,
        'pricing.platformFee': platformFee,
        'pricing.total': Math.max(0, total),
        voucherId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const userVoucherUpdate = {
        remainingUses,
        userId,
        voucherId,
        updatedAt: timestamp,
      };

      if (userVoucherDoc.exists) {
        transaction.update(userVoucherRef, userVoucherUpdate);
      } else {
        transaction.set(userVoucherRef, {
          ...userVoucherUpdate,
          usedAt: [timestamp],
          maxUses: voucher.maxUses || 1,
          createdAt: now,
        });
      }

      transaction.update(voucherRef, {
        usedCount: admin.firestore.FieldValue.increment(1),
      });
    });

    // Suppress unused-var warning from pre-read-only shape (kept for future
    // refactors where metadata-only reads may want access to it).
    void bookingPre;
    void newTax;
    void newPlatformFee;

    // S4: Audit log — record the voucher redemption so admins can trace
    // abuse patterns (one user rapidly cycling through codes) and so the
    // customer's "rewards history" UI has an authoritative source even
    // if the `user_vouchers` doc is later migrated/compacted.
    try {
      await writeAuditLog({
        userId,
        action: 'voucher.redeemed',
        entity: { type: 'voucher', id: voucherId },
        before: null,
        after: {
          bookingId: validated.bookingId,
          discountAmount,
          newTotal: Math.max(0, newTotal),
          remainingUses,
        },
        metadata: {
          code: voucher.code,
          discountType: voucher.discountType,
          discountValue: voucher.discountValue,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (redeemVoucher)', auditError);
    }

    return {
      success: true,
      discountAmount,
      newTotal: Math.max(0, newTotal),
      remainingUses,
      voucherName: voucher.code,
    };

  } catch (error: unknown) {
    throw handleError(error);
  }
    },
  ),
);
