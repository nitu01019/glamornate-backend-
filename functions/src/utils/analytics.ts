import * as admin from 'firebase-admin';
import { todayIST, formatDateIST } from './date-ist';

const db = admin.firestore();

// ============================================================================
// Firestore Document Interfaces (for type-safe data access)
// ============================================================================

interface BookingDocData {
  bookingStatus: string;
  pricing?: { total?: number; platformFee?: number };
  userId: string;
  spaId: string;
  createdAt?: admin.firestore.Timestamp;
  [key: string]: unknown;
}

interface TransactionDocData {
  amount?: { total?: number };
  platformFee?: number;
  [key: string]: unknown;
}

// ============================================================================
// Analytics Aggregation
// ============================================================================

export interface AnalyticsData {
  type: string;
  period: string;
  date: string;
  data: Record<string, number | string>;
  timestamp: admin.firestore.Timestamp;
}

/**
 * Aggregate daily bookings analytics
 */
export async function aggregateDailyBookings(date: string): Promise<void> {
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59`);

  const bookingsSnapshot = await db.collection('bookings')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .get();

  const bookings = bookingsSnapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as BookingDocData) }));

  const analyticsData: Record<string, number> = {
    total: bookings.length,
    // Legacy status — coexists during 14-day Stripe-stub grace; remove on 2026-05-16 (Wave 12).
    draft: bookings.filter(b => b.bookingStatus === 'draft').length,
    // Legacy status — coexists during 14-day Stripe-stub grace; remove on 2026-05-16 (Wave 12).
    paymentPending: bookings.filter(b => b.bookingStatus === 'payment_pending').length,
    confirmed: bookings.filter(b => b.bookingStatus === 'confirmed').length,
    inProgress: bookings.filter(b => b.bookingStatus === 'in_progress').length,
    completed: bookings.filter(b => b.bookingStatus === 'completed').length,
    cancelled: bookings.filter(b => b.bookingStatus === 'cancelled').length,
  };

  // Calculate revenue
  const completedBookings = bookings.filter(b => b.bookingStatus === 'completed');
  analyticsData.revenue = completedBookings.reduce((sum, b) => sum + (b.pricing?.total || 0), 0);
  analyticsData.platformFee = completedBookings.reduce((sum, b) => sum + (b.pricing?.platformFee || 0), 0);

  // Unique users
  const uniqueUsers = new Set(bookings.map(b => b.userId));
  analyticsData.uniqueUsers = uniqueUsers.size;

  // Unique spas
  const uniqueSpas = new Set(bookings.map(b => b.spaId));
  analyticsData.uniqueSpas = uniqueSpas.size;

  await saveAnalytics('bookings', 'daily', date, analyticsData);
}

/**
 * Aggregate daily revenue analytics
 */
export async function aggregateDailyRevenue(date: string): Promise<void> {
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59`);

  const transactionsSnapshot = await db.collection('transactions')
    .where('type', '==', 'booking_payment')
    .where('status', '==', 'succeeded')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .get();

  const transactions = transactionsSnapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as TransactionDocData) }));

  const analyticsData: Record<string, number> = {
    total: transactions.length,
    grossRevenue: transactions.reduce((sum, t) => sum + (t.amount?.total || 0), 0),
    platformFee: transactions.reduce((sum, t) => sum + (t.platformFee || 0), 0),
    spaRevenue: transactions.reduce((sum, t) => sum + (t.amount?.total || 0) - (t.platformFee || 0), 0),
    averageOrderValue: transactions.length > 0
      ? transactions.reduce((sum, t) => sum + (t.amount?.total || 0), 0) / transactions.length
      : 0,
  };

  await saveAnalytics('revenue', 'daily', date, analyticsData);
}

/**
 * Aggregate hour-level bookings for real-time monitoring
 */
export async function aggregateHourlyBookings(
  date: string,
  hour: number
): Promise<void> {
  const hourStart = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`);
  const hourEnd = new Date(`${date}T${String(hour).padStart(2, '0')}:59:59`);

  const bookingsSnapshot = await db.collection('bookings')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(hourStart))
    .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(hourEnd))
    .get();

  const bookings = bookingsSnapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as BookingDocData) }));

  const analyticsData: Record<string, number> = {
    total: bookings.length,
    confirmed: bookings.filter(b => b.bookingStatus === 'confirmed').length,
    completed: bookings.filter(b => b.bookingStatus === 'completed').length,
    cancelled: bookings.filter(b => b.bookingStatus === 'cancelled').length,
  };

  await saveAnalytics('bookings', 'hourly', `${date}_${hour}`, analyticsData);
}

/**
 * Aggregate user activity analytics
 */
export async function aggregateUserActivity(date: string): Promise<void> {
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59`);

  // Get users who logged in today
  const activeUsersSnapshot = await db.collection('users')
    .where('lastLoginAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('lastLoginAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .get();

  const analyticsData: Record<string, number> = {
    activeUsers: activeUsersSnapshot.docs.length,
    newUsers: activeUsersSnapshot.docs.filter(d => {
      const createdAt = d.data().createdAt?.toDate() || new Date();
      return createdAt >= startOfDay && createdAt <= endOfDay;
    }).length,
  };

  await saveAnalytics('users', 'daily', date, analyticsData);
}

/**
 * Aggregate spa performance analytics
 */
export async function aggregateSpaPerformance(date: string): Promise<void> {
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59`);

  const completedBookings = await db.collection('bookings')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
    .where('bookingStatus', '==', 'completed')
    .get();

  const spaData = new Map<string, {
    bookings: number;
    revenue: number;
    rating: number;
    ratingCount: number;
  }>();

  completedBookings.docs.forEach(doc => {
    const booking = doc.data();
    const spaId = booking.spaId;

    if (!spaData.has(spaId)) {
      spaData.set(spaId, { bookings: 0, revenue: 0, rating: 0, ratingCount: 0 });
    }

    const data = spaData.get(spaId)!;
    data.bookings++;
    data.revenue += booking.pricing?.total || 0;
  });

  // Write spa-specific analytics
  const batch = db.batch();
  for (const [spaId, data] of spaData.entries()) {
    const docId = `spas_${date}_${spaId}`;
    const docRef = db.collection('analytics').doc(docId);

    batch.set(docRef, {
      compositeId: docId,
      type: 'spas',
      period: 'daily',
      date,
      spaId,
      data,
      timestamp: admin.firestore.Timestamp.now(),
    });
  }

  await batch.commit();
}

/**
 * Save analytics data
 */
async function saveAnalytics(
  type: string,
  period: string,
  date: string,
  data: Record<string, number | string>
): Promise<void> {
  const compositeId = `${type}_${period}_${date}`;
  const docRef = db.collection('analytics').doc(compositeId);

  await docRef.set({
    compositeId,
    type,
    period,
    date,
    data,
    timestamp: admin.firestore.Timestamp.now(),
  });
}

/**
 * Get analytics data for a date range
 */
export async function getAnalytics(
  type: string,
  period: 'daily' | 'weekly' | 'monthly' | 'hourly',
  startDate: string,
  endDate: string
): Promise<AnalyticsData[]> {
  const query = db.collection('analytics')
    .where('type', '==', type)
    .where('period', '==', period)
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .orderBy('date', 'asc');

  const snapshot = await query.get();
  return snapshot.docs.map(doc => doc.data() as AnalyticsData);
}

/**
 * Get analytics summary for a specific type
 */
export async function getAnalyticsSummary(
  type: string,
  period: 'daily' | 'weekly' | 'monthly',
  days: number = 30
): Promise<{
  total: number;
  average: number;
  trend: 'up' | 'down' | 'stable';
  data: AnalyticsData[];
}> {
  const endDateStr = todayIST();
  const endDate = new Date(`${endDateStr}T00:00:00+05:30`);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - days);

  const data = await getAnalytics(
    type,
    period,
    formatDateIST(startDate),
    endDateStr
  );

  if (data.length === 0) {
    return { total: 0, average: 0, trend: 'stable', data: [] };
  }

  const total = data.reduce((sum, d) => {
    const value = typeof d.data.total === 'number' ? d.data.total : 0;
    return sum + value;
  }, 0);

  const average = total / data.length;

  // Calculate trend based on first and last half
  const midPoint = Math.floor(data.length / 2);
  const firstHalf = data.slice(0, midPoint);
  const secondHalf = data.slice(midPoint);

  const firstHalfSum = firstHalf.reduce((sum, d) =>
    sum + (typeof d.data.total === 'number' ? d.data.total : 0), 0
  );
  const secondHalfSum = secondHalf.reduce((sum, d) =>
    sum + (typeof d.data.total === 'number' ? d.data.total : 0), 0
  );

  const firstHalfAvg = firstHalf.length > 0 ? firstHalfSum / firstHalf.length : 0;
  const secondHalfAvg = secondHalf.length > 0 ? secondHalfSum / secondHalf.length : 0;

  const threshold = average * 0.1; // 10% threshold
  let trend: 'up' | 'down' | 'stable' = 'stable';

  if (secondHalfAvg - firstHalfAvg > threshold) {
    trend = 'up';
  } else if (firstHalfAvg - secondHalfAvg > threshold) {
    trend = 'down';
  }

  return { total, average, trend, data };
}

/**
 * Real-time dashboard metrics
 */
export async function getDashboardMetrics(): Promise<{
  activeBookings: number;
  completedToday: number;
  revenueToday: number;
  activeUsers: number;
  activeSpas: number;
}> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [activeSnap, completedSnap, revenueSnap, usersSnap, spasSnap] = await Promise.all([
    db.collection('bookings')
      .where('bookingStatus', 'in', ['confirmed', 'en_route', 'in_progress'])
      .count()
      .get(),

    db.collection('bookings')
      .where('bookingStatus', '==', 'completed')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .count()
      .get(),

    db.collection('transactions')
      .where('type', '==', 'booking_payment')
      .where('status', '==', 'succeeded')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .get(),

    db.collection('users')
      .where('isActive', '==', true)
      .count()
      .get(),

    db.collection('spas')
      .where('isActive', '==', true)
      .where('status', '==', 'active')
      .count()
      .get(),
  ]);

  const revenueToday = revenueSnap.docs.reduce(
    (sum, doc) => sum + (doc.data().amount?.total || 0), 0
  );

  return {
    activeBookings: activeSnap.data().count,
    completedToday: completedSnap.data().count,
    revenueToday,
    activeUsers: usersSnap.data().count,
    activeSpas: spasSnap.data().count,
  };
}

/**
 Track booking funnel conversion rates
 */
export async function trackFunnelMetrics(date: string): Promise<void> {
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59`);

  const [draftSnap, paymentSnap, confirmedSnap, completedSnap] = await Promise.all([
    // Legacy status — coexists during 14-day Stripe-stub grace; remove on 2026-05-16 (Wave 12).
    db.collection('bookings')
      .where('bookingStatus', '==', 'draft')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
      .get(),

    // Legacy status — coexists during 14-day Stripe-stub grace; remove on 2026-05-16 (Wave 12).
    db.collection('bookings')
      .where('bookingStatus', '==', 'payment_pending')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
      .get(),

    db.collection('bookings')
      .where('bookingStatus', '==', 'confirmed')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
      .get(),

    db.collection('bookings')
      .where('bookingStatus', '==', 'completed')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay))
      .get(),
  ]);

  const draftCount = draftSnap.docs.length;
  const paymentCount = paymentSnap.docs.length;
  const confirmedCount = confirmedSnap.docs.length;
  const completedCount = completedSnap.docs.length;

  const funnelData = {
    initiated: draftCount,
    reachedPayment: paymentCount,
    confirmed: confirmedCount,
    completed: completedCount,
    paymentInitiationRate: draftCount > 0 ? (paymentCount / draftCount) * 100 : 0,
    confirmationRate: paymentCount > 0 ? (confirmedCount / paymentCount) * 100 : 0,
    completionRate: confirmedCount > 0 ? (completedCount / confirmedCount) * 100 : 0,
    overallConversionRate: draftCount > 0 ? (completedCount / draftCount) * 100 : 0,
  };

  await saveAnalytics('conversion', 'daily', date, funnelData);
}
