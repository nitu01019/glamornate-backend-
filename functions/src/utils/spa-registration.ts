import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { indexSpa } from './search';
import { notificationTemplates } from './notifications';
import { enqueueNotificationFromContext } from './notifications-outbox';
import { formatDateIST } from './date-ist';

const db = admin.firestore();

// ============================================================================
// Spa Registration Utilities
// ============================================================================

export interface SpaRegistrationData {
  name: string;
  slug: string;
  description: string;
  shortDescription: string;
  featuredImage: string;
  gallery: string[];
  location: {
    address: string;
    city: string;
    state: string;
    pincode: string;
    geo: { lat: number; lng: number };
    timezone: string;
  };
  contact: {
    phone: string;
    email?: string;
    website?: string;
    whatsapp?: string;
  };
  categories: string[];
  amenities: string[];
  operatingHours: Record<string, { open: string; close: string; isOpen: boolean }>;
  verificationDocuments: Array<{
    type: string;
    url: string;
  }>;
}

/**
 * Submit spa registration application
 */
export async function submitSpaRegistration(
  userId: string,
  data: SpaRegistrationData
): Promise<{ spaId: string; status: string }> {
  // Check if user already has a registered spa
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const userData = userDoc.data();
  if (userData?.spaData?.spaId) {
    throw new functions.https.HttpsError(
      'already-exists',
      'You already have a registered spa'
    );
  }

  // Create spa with pending verification status
  const spaRef = await db.collection('spas').add({
    ...data,
    rating: { overall: 0, count: 0, breakdown: { ambiance: 0, service: 0, hygiene: 0, therapist: 0 } },
    tier: 'basic',
    commission: { platformPercentage: 20, fixedFee: 0 },
    payout: {
      bankAccount: null,
      payoutFrequency: 'weekly',
    },
    status: 'pending',
    verification: {
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      documents: data.verificationDocuments.map(doc => ({
        ...doc,
        status: 'pending',
      })),
    },
    statistics: {
      totalBookings: 0,
      revenue: 0,
      averageRating: 0,
      activeStaff: 0,
    },
    seo: {
      metaTitle: data.name,
      metaDescription: data.shortDescription,
      keywords: data.categories,
    },
    isActive: false, // Set to active after verification
    ownerId: userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Update user with spaId
  await userDoc.ref.update({
    role: 'spa_owner',
    spaData: {
      spaId: spaRef.id,
      permissions: ['read', 'write', 'delete', 'staff'],
      commissionRate: 20,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Send notification to admin team
  await notifyAdminAboutNewSpa(spaRef.id, data.name, userId);

  functions.logger.info('Spa registration submitted', { spaId: spaRef.id, userId });

  return { spaId: spaRef.id, status: 'pending' };
}

/**
 * Verify spa (admin action)
 */
export async function verifySpa(
  spaId: string,
  adminId: string,
  approved: boolean,
 拒绝原因?: string
): Promise<void> {
  const spaRef = db.collection('spas').doc(spaId);
  const spaDoc = await spaRef.get();

  if (!spaDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Spa not found');
  }

  const spa = spaDoc.data();
  if (!spa) {
    throw new functions.https.HttpsError('not-found', 'Spa data not found');
  }

  const updateData: Record<string, unknown> = {
    status: approved ? 'active' : 'rejected',
    isActive: approved,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (approved) {
    updateData.verification = {
      ...spa.verification,
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  } else if (拒绝原因) {
    updateData.verification = {
      ...spa.verification,
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectionReason: 拒绝原因,
    };
  }

  await spaRef.update(updateData);

  // Index spa in Algolia if approved
  if (approved) {
    await indexSpa(spaId);

    // Send notification to spa owner
    await enqueueNotificationFromContext(
      notificationTemplates.spaVerified(spaId, spa.ownerId)
    );
  } else {
    // Send rejection notification
    await db.collection('notifications').add({
      userId: spa.ownerId,
      type: 'spa_rejected',
      title: 'Spa Registration Rejected',
      body: 拒绝原因 || 'Your spa registration could not be verified. Please contact support.',
      data: { spaId, type: 'spa_rejected' },
      read: false,
      channels: { push: true, email: true, sms: false },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  functions.logger.info(`Spa verification ${approved ? 'approved' : 'rejected'}`, { spaId, adminId });
}

/**
 * Update spa details
 */
export async function updateSpaDetails(
  spaId: string,
  userId: string,
  updates: Partial<SpaRegistrationData> & { ownerId?: string }
): Promise<void> {
  const spaRef = db.collection('spas').doc(spaId);
  const spaDoc = await spaRef.get();

  if (!spaDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Spa not found');
  }

  const spa = spaDoc.data();
  if (!spa) {
    throw new functions.https.HttpsError('not-found', 'Spa data not found');
  }

  // verify ownership
  if (spa.ownerId !== userId) {
    await verifySpaAccess(userId, spaId);
  }

  await spaRef.update({
    ...updates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Reindex if search-related fields changed
  if (updates.name || updates.categories || updates.location) {
    await indexSpa(spaId);
  }
}

/**
 * Upload verification document
 */
export async function uploadVerificationDocument(
  spaId: string,
  userId: string,
  document: {
    type: string;
    url: string;
  }
): Promise<void> {
  await verifySpaAccess(userId, spaId);

  const spaRef = db.collection('spas').doc(spaId);
  const spaDoc = await spaRef.get();

  if (!spaDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Spa not found');
  }

  const spa = spaDoc.data();
  if (!spa) {
    throw new functions.https.HttpsError('not-found', 'Spa data not found');
  }
  const documents = spa.verification?.documents || [];

  // Replace existing document of same type
  const existingIndex = (documents as Array<{ type: string; url?: string; status?: string }>).findIndex(
    (doc) => doc.type === document.type
  );

  if (existingIndex >= 0) {
    documents[existingIndex] = {
      ...document,
      status: 'pending',
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  } else {
    documents.push({
      ...document,
      status: 'pending',
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await spaRef.update({
    'verification.documents': documents,
    'verification.submittedAt': admin.firestore.FieldValue.serverTimestamp(),
    status: 'pending',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Notify admins
  await notifyAdminAboutDocumentUpload(spaId, document.type);
}

/**
 * Get pending registrations (admin view)
 */
export async function getPendingRegistrations(): Promise<any[]> {
  const snapshot = await db.collection('spas')
    .where('status', '==', 'pending')
    .orderBy('verification.submittedAt', 'desc')
    .limit(50)
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

/**
 * Get spa statistics
 */
export async function getSpaStatistics(spaId: string, period: 'day' | 'week' | 'month' | 'all' = 'all'): Promise<any> {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case 'day':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      startDate = new Date(now.setMonth(now.getMonth() - 1));
      break;
    default:
      startDate = new Date(0);
  }

  const bookingsSnapshot = await db.collection('bookings')
    .where('spaId', '==', spaId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startDate))
    .get();

  const bookings = bookingsSnapshot.docs.map(doc => {
    const data = doc.data() as { bookingStatus?: string; pricing?: { total?: number }; slot?: { date?: string }; [key: string]: unknown };
    return { id: doc.id, ...data };
  });

  const stats = {
    totalBookings: bookings.length,
    confirmedBookings: bookings.filter(b => b.bookingStatus === 'confirmed').length,
    completedBookings: bookings.filter(b => b.bookingStatus === 'completed').length,
    cancelledBookings: bookings.filter(b => b.bookingStatus === 'cancelled').length,
    totalRevenue: bookings
      .filter(b => b.bookingStatus === 'completed')
      .reduce((sum, b) => sum + (b.pricing?.total || 0), 0),
    averageRating: 0,
    bookingByStatus: {} as Record<string, number>,
    bookingByDay: {} as Record<string, number>,
  };

  // Calculate average rating
  const reviewsSnapshot = await db.collection('reviews')
    .where('spaId', '==', spaId)
    .get();

  if (!reviewsSnapshot.empty) {
    const reviews = reviewsSnapshot.docs.map(doc => doc.data());
    stats.averageRating =
      reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
  }

  // Group by status
  const statuses = ['draft', 'payment_pending', 'confirmed', 'en_route', 'in_progress', 'completed', 'cancelled'];
  statuses.forEach(status => {
    stats.bookingByStatus[status] = bookings.filter(b => b.bookingStatus === status).length;
  });

  // Group by day (last 7 days)
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = formatDateIST(date);
    stats.bookingByDay[dateStr] = bookings.filter(b => b.slot?.date === dateStr).length;
  }

  return stats;
}

/**
 * Get spa payout information
 */
export async function getSpaPayouts(
  spaId: string,
  status?: 'pending' | 'processing' | 'paid'
): Promise<any[]> {
  let query: FirebaseFirestore.Query = db.collection('payouts').where('spaId', '==', spaId);

  if (status) {
    query = query.where('status', '==', status);
  }

  query = query.orderBy('period.start', 'desc').limit(50);

  const snapshot = await query.get();
  return snapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => ({ id: doc.id, ...doc.data() }));
}

// ============================================================================
// Helper Functions
// ============================================================================

async function verifySpaAccess(userId: string, spaId: string): Promise<void> {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const userData = userDoc.data();
  if (!userData) {
    throw new functions.https.HttpsError('not-found', 'User data not found');
  }

  const hasAccess =
    userData.role === 'admin' ||
    userData.spaData?.spaId === spaId ||
    (userData.role === 'spa_staff' && userData.spaData?.spaId === spaId);

  if (!hasAccess) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized');
  }
}

async function notifyAdminAboutNewSpa(spaId: string, spaName: string, userId: string): Promise<void> {
  const adminUsersSnapshot = await db.collection('users')
    .where('role', '==', 'admin')
    .where('isActive', '==', true)
    .get();

  for (const adminDoc of adminUsersSnapshot.docs) {
    await db.collection('notifications').add({
      userId: adminDoc.id,
      type: 'spa_verification_request',
      title: 'New Spa Registration',
      body: `${spaName} has submitted their registration for verification`,
      data: { spaId, userId, type: 'spa_verification' },
      read: false,
      channels: { push: true, email: true, sms: false },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function notifyAdminAboutDocumentUpload(spaId: string, documentType: string): Promise<void> {
  const adminUsersSnapshot = await db.collection('users')
    .where('role', '==', 'admin')
    .where('isActive', '==', true)
    .get();

  for (const adminDoc of adminUsersSnapshot.docs) {
    await db.collection('notifications').add({
      userId: adminDoc.id,
      type: 'spa_document_upload',
      title: 'Verification Document Updated',
      body: `New ${documentType} document uploaded for spa verification`,
      data: { spaId, documentType, type: 'spa_document' },
      read: false,
      channels: { push: true, email: false, sms: false },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

/**
 * Update spa operating hours
 */
export async function updateOperatingHours(
  spaId: string,
  userId: string,
  operatingHours: Record<string, { open: string; close: string; isOpen: boolean }>
): Promise<void> {
  await verifySpaAccess(userId, spaId);

  const spaRef = db.collection('spas').doc(spaId);
  await spaRef.update({
    operatingHours,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Trigger availability recalculation
  // This would normally be done by a scheduled function
  functions.logger.info(`Operating hours updated for spa ${spaId}`, { userId });
}

/**
 * Add service to spa catalog
 */
export async function addSpaService(
  spaId: string,
  userId: string,
  serviceData: {
    serviceId: string;
    priceOverride?: number;
    durationOverride?: number;
    customName?: string;
    isActive: boolean;
  }
): Promise<void> {
  await verifySpaAccess(userId, spaId);

  const compositeId = `${spaId}_${serviceData.serviceId}`;
  const docRef = db.collection('spa_services').doc(compositeId);

  await docRef.set({
    compositeId,
    spaId,
    ...serviceData,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Update spa commission settings
 */
export async function updateCommissionSettings(
  spaId: string,
  userId: string,
  commission: {
    platformPercentage: number;
    fixedFee: number;
  }
): Promise<void> {
  // Only admins can update commission
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const userData = userDoc.data();
  if (!userData || userData.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized');
  }

  const spaRef = db.collection('spas').doc(spaId);
  await spaRef.update({
    commission,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Update spa payout information
 */
export async function updatePayoutInfo(
  spaId: string,
  userId: string,
  payout: {
    bankAccount: {
      accountNumber: string;
      ifsc: string;
      accountName: string;
    };
    payoutFrequency: 'daily' | 'weekly' | 'monthly';
  }
): Promise<void> {
  await verifySpaAccess(userId, spaId);

  const spaRef = db.collection('spas').doc(spaId);
  await spaRef.update({
    payout: {
      ...payout,
      nextPayoutDate: calculateNextPayoutDate(payout.payoutFrequency),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function calculateNextPayoutDate(frequency: 'daily' | 'weekly' | 'monthly'): Date {
  const now = new Date();

  switch (frequency) {
    case 'daily':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    case 'weekly':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    case 'monthly':
      const nextMonth = new Date(now);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      return nextMonth;
  }
}
