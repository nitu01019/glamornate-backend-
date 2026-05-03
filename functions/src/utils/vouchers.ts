import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

const db = admin.firestore();

// ============================================================================
// Voucher Validation and Application
// ============================================================================

/**
 * Voucher document shape stored in `vouchers/<id>`.
 * Loose type — only fields used by the validator are enumerated; extra keys
 * (e.g. metadata, createdAt) are tolerated via the index signature.
 *
 * NOTE: optional gating fields (minOrderAmount, maxDiscountAmount,
 * applicableSpas, applicableServices) are typed as required-but-possibly-zero
 * to mirror the existing runtime treatment in `validateVoucher` (which reads
 * them without nullish guards). Behaviour preserved verbatim.
 */
export interface VoucherDocData {
  id: string;
  code: string;
  type?: 'discount' | 'gift_card' | 'referral';
  discountType: 'percentage' | 'flat' | 'fixed_price';
  discountValue: number;
  validFrom: string;
  validUntil: string;
  isActive?: boolean;
  usedCount: number;
  usageLimit: number;
  applicableSpas: string[] | undefined;
  applicableServices: string[];
  minOrderAmount: number;
  maxDiscountAmount: number;
  [key: string]: unknown;
}

export interface VoucherValidation {
  valid: boolean;
  voucher?: VoucherDocData;
  discountAmount: number;
  error?: string;
}

export async function validateVoucher(
  code: string,
  userId: string,
  bookingData: {
    spaId: string;
    serviceIds: string[];
    totalAmount: number;
  }
): Promise<VoucherValidation> {
  // Get voucher
  const voucherQuery = await db
    .collection('vouchers')
    .where('code', '==', code.toUpperCase())
    .where('isActive', '==', true)
    .limit(1)
    .get();

  if (voucherQuery.empty) {
    return {
      valid: false,
      discountAmount: 0,
      error: 'Invalid voucher code',
    };
  }

  const voucherDoc = voucherQuery.docs[0];
  const voucher: VoucherDocData = { id: voucherDoc.id, ...voucherDoc.data() } as VoucherDocData;

  // Check if expired
  const now = new Date();
  const validFrom = new Date(voucher.validFrom);
  const validUntil = new Date(voucher.validUntil);

  if (now < validFrom || now > validUntil) {
    return {
      valid: false,
      discountAmount: 0,
      error: 'This voucher has expired',
    };
  }

  // Check usage limit
  if (voucher.usedCount >= voucher.usageLimit) {
    return {
      valid: false,
      discountAmount: 0,
      error: 'This voucher has been fully redeemed',
    };
  }

  // Check user-specific usage limit
  const userVoucherQuery = await db
    .collection('user_vouchers')
    .doc(`${userId}_${voucher.id}`)
    .get();

  if (userVoucherQuery.exists) {
    const userVoucher = userVoucherQuery.data();
    if (userVoucher && userVoucher.remainingUses <= 0) {
      return {
        valid: false,
        discountAmount: 0,
        error: 'You have already used this voucher',
      };
    }
  }

  // Check minimum order amount
  if (voucher.minOrderAmount > 0 && bookingData.totalAmount < voucher.minOrderAmount) {
    return {
      valid: false,
      discountAmount: 0,
      error: `Minimum order amount of ₹${voucher.minOrderAmount} required`,
    };
  }

  // Check if applies to this spa/services
  let applicable = true;

  if (voucher.applicableSpas && voucher.applicableSpas.length > 0) {
    applicable = voucher.applicableSpas.includes(bookingData.spaId);
  }

  if (applicable && voucher.applicableServices && voucher.applicableServices.length > 0) {
    const hasApplicableService = bookingData.serviceIds.some(id =>
      voucher.applicableServices.includes(id)
    );
    applicable = hasApplicableService;
  }

  if (!applicable) {
    return {
      valid: false,
      discountAmount: 0,
      error: 'This voucher is not applicable to your selection',
    };
  }

  // Calculate discount
  let discountAmount = 0;

  switch (voucher.discountType) {
    case 'percentage':
      discountAmount = (bookingData.totalAmount * voucher.discountValue) / 100;
      break;
    case 'flat':
    case 'fixed_price':
      discountAmount = voucher.discountValue;
      break;
  }

  // Apply max discount cap
  if (voucher.maxDiscountAmount > 0 && discountAmount > voucher.maxDiscountAmount) {
    discountAmount = voucher.maxDiscountAmount;
  }

  // Ensure discount doesn't exceed total
  discountAmount = Math.min(discountAmount, bookingData.totalAmount);

  return {
    valid: true,
    voucher,
    discountAmount: Math.round(discountAmount),
  };
}

export async function useVoucher(
  voucherId: string,
  userId: string,
  bookingId: string
): Promise<boolean> {
  const batch = db.batch();

  // Update voucher usage count
  const voucherRef = db.collection('vouchers').doc(voucherId);
  batch.update(voucherRef, {
    usedCount: admin.firestore.FieldValue.increment(1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Update user voucher usage
  const userVoucherRef = db.collection('user_vouchers').doc(`${userId}_${voucherId}`);
  const userVoucherDoc = await userVoucherRef.get();

  if (userVoucherDoc.exists) {
    batch.update(userVoucherRef, {
      remainingUses: admin.firestore.FieldValue.increment(-1),
      usedAt: admin.firestore.FieldValue.arrayUnion(bookingId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    batch.set(userVoucherRef, {
      compositeId: `${userId}_${voucherId}`,
      remainingUses: 0,
      maxUses: 1,
      usedAt: [bookingId],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  functions.logger.info(`Voucher used`, { voucherId, userId, bookingId });

  return true;
}

export async function releaseVoucher(
  voucherId: string,
  userId: string,
  bookingId: string
): Promise<boolean> {
  const batch = db.batch();

  // Decrement voucher usage count
  const voucherRef = db.collection('vouchers').doc(voucherId);
  batch.update(voucherRef, {
    usedCount: admin.firestore.FieldValue.increment(-1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Restore user voucher usage
  const userVoucherRef = db.collection('user_vouchers').doc(`${userId}_${voucherId}`);
  const userVoucherDoc = await userVoucherRef.get();

  if (userVoucherDoc.exists) {
    const userVoucher = userVoucherDoc.data();
    const updatedUsedAt = (userVoucher?.usedAt || []).filter((id: string) => id !== bookingId);

    batch.update(userVoucherRef, {
      remainingUses: admin.firestore.FieldValue.increment(1),
      usedAt: updatedUsedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  functions.logger.info(`Voucher released`, { voucherId, userId, bookingId });

  return true;
}

export async function createVoucher(data: {
  code: string;
  type: 'discount' | 'gift_card' | 'referral';
  discountType: 'percentage' | 'flat' | 'fixed_price';
  discountValue: number;
  usageLimit: number;
  validFrom: string;
  validUntil: string;
  applicableServices?: string[];
  applicableSpas?: string[];
  minOrderAmount?: number;
  maxDiscountAmount?: number;
}): Promise<string> {
  const docRef = await db.collection('vouchers').add({
    ...data,
    code: data.code.toUpperCase(),
    usedCount: 0,
    isActive: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return docRef.id;
}

export async function getUserVouchers(userId: string): Promise<any[]> {
  const now = new Date().toISOString();

  const userVouchersSnapshot = await db
    .collection('user_vouchers')
    .where('compositeId', '>=', `${userId}_`)
    .where('compositeId', '<', `${userId}_\uf8ff`)
    .get();

  const voucherIds = userVouchersSnapshot.docs.map(doc =>
    doc.id.split('_').slice(1).join('_')
  );

  if (voucherIds.length === 0) {
    return [];
  }

  const vouchersSnapshot = await db
    .collection('vouchers')
    .where('__name__', 'in', voucherIds)
    .where('isActive', '==', true)
    .where('validUntil', '>', now)
    .get();

  const vouchers = vouchersSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  // Merge user voucher data (remaining uses)
  return vouchers.map(voucher => {
    const userVoucher = userVouchersSnapshot.docs.find(
      doc => doc.id.endsWith(voucher.id)
    );
    return {
      ...voucher,
      remainingUses: userVoucher?.data()?.remainingUses || 1,
      userVoucherId: userVoucher?.id,
    };
  });
}

// ============================================================================
// Referral System
// ============================================================================

export async function generateReferralCode(userId: string): Promise<string> {
  // Generate a random 8-character code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  // Create referral voucher
  await createVoucher({
    code,
    type: 'referral',
    discountType: 'percentage',
    discountValue: 10, // 10% discount for referee
    usageLimit: 100,
    validFrom: new Date().toISOString(),
    validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
    maxDiscountAmount: 500, // Max ₹500
  });

  // Award referrer
  await db.collection('users').doc(userId).update({
    referralCode: code,
    referralCount: admin.firestore.FieldValue.increment(0),
    totalReferralCredits: admin.firestore.FieldValue.increment(0),
  });

  return code;
}

export async function processReferralReward(
  referrerId: string,
  referredUserId: string
): Promise<void> {
  // Credit referrer with ₹200
  await creditWallet(referrerId, 200, 'Referral bonus');

  // Log referral
  await db.collection('referrals').add({
    referrerId,
    referredUserId,
    creditedAmount: 200,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  functions.logger.info('Referral reward processed', { referrerId, referredUserId });
}

// ============================================================================
// Wallet Credits
// ============================================================================

export async function creditWallet(
  userId: string,
  amount: number,
  description: string,
  reference?: string
): Promise<void> {
  const walletRef = db.collection('wallets').doc(userId);
  const walletDoc = await walletRef.get();

  const now = admin.firestore.Timestamp.now();
  const transaction = {
    id: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: 'credit' as const,
    amount,
    description,
    reference,
    createdAt: now,
  };

  if (walletDoc.exists) {
    await walletRef.update({
      'balance.current': admin.firestore.FieldValue.increment(amount),
      'balance.credited': admin.firestore.FieldValue.increment(amount),
      transactions: admin.firestore.FieldValue.arrayUnion(transaction),
      updatedAt: now,
    });
  } else {
    await walletRef.set({
      userId,
      currency: 'INR',
      balance: {
        current: amount,
        credited: amount,
        debited: 0,
      },
      transactions: [transaction],
      createdAt: now,
      updatedAt: now,
    });
  }

  // Send notification
  await db.collection('notifications').add({
    userId,
    type: 'wallet_credit',
    title: 'Wallet Credited',
    body: `₹${amount} has been added to your wallet. ${description}`,
    data: { type: 'wallet', amount },
    read: false,
    channels: { push: true, email: false, sms: false },
    createdAt: now,
  });
}

export async function debitWallet(
  userId: string,
  amount: number,
  description: string,
  reference?: string
): Promise<{ success: boolean; error?: string }> {
  const walletRef = db.collection('wallets').doc(userId);

  try {
    await db.runTransaction(async (txn) => {
      const walletDoc = await txn.get(walletRef);

      if (!walletDoc.exists) {
        throw new Error('Wallet not found');
      }

      const wallet = walletDoc.data();

      if (!wallet || wallet.balance.current < amount) {
        throw new Error('Insufficient wallet balance');
      }

      const now = admin.firestore.Timestamp.now();
      const transaction = {
        id: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'debit' as const,
        amount,
        description,
        reference,
        createdAt: now,
      };

      txn.update(walletRef, {
        'balance.current': admin.firestore.FieldValue.increment(-amount),
        'balance.debited': admin.firestore.FieldValue.increment(amount),
        transactions: admin.firestore.FieldValue.arrayUnion(transaction),
        updatedAt: now,
      });
    });

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Debit failed';
    return { success: false, error: message };
  }
}

export async function getWalletBalance(userId: string): Promise<number> {
  const walletDoc = await db.collection('wallets').doc(userId).get();

  if (!walletDoc.exists) {
    return 0;
  }

  return walletDoc.data()?.balance?.current || 0;
}
