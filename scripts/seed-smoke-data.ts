/**
 * Seed smoke data for the Glamornate Firebase project.
 *
 * Idempotent: every document is written with `{ merge: true }` keyed by a
 * stable ID so re-running the script updates (not duplicates) data.
 *
 * Guards:
 *   - `FIREBASE_PROJECT_ID` MUST equal `glamornate-758c6`.
 *   - `CONFIRM_PROD_SEED`   MUST equal `yes`.
 *
 * Seeds:
 *   - 8  categories
 *   - 12 services (4 per category x 3 categories)
 *   - 3  promotions (one percent, one flat, one deal-of-day)
 *   - 6  spas in Pune with nested services subcollection (3 services each)
 *   - 10 trendingSearches
 *
 * Usage:
 *   FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes \
 *     npm run seed:smoke
 */

import * as admin from 'firebase-admin';

// ---------------------------------------------------------------------------
// Env guards
// ---------------------------------------------------------------------------
const REQUIRED_PROJECT = 'glamornate-758c6';
const projectId = process.env.FIREBASE_PROJECT_ID;
const confirm = process.env.CONFIRM_PROD_SEED;

if (projectId !== REQUIRED_PROJECT) {
  // eslint-disable-next-line no-console
  console.error(
    `[seed] Aborted: FIREBASE_PROJECT_ID must equal "${REQUIRED_PROJECT}" (got "${projectId ?? '<unset>'}")`,
  );
  process.exit(1);
}
if (confirm !== 'yes') {
  // eslint-disable-next-line no-console
  console.error(
    '[seed] Aborted: CONFIRM_PROD_SEED must equal "yes" to acknowledge this is a destructive seed.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Admin SDK with default ADC
// ---------------------------------------------------------------------------
admin.initializeApp({ projectId });
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Seed data definitions
// ---------------------------------------------------------------------------
const CATEGORIES = [
  {
    id: 'facials',
    name: 'Facials',
    slug: 'facials',
    description: 'Glow-boosting facial treatments',
    image: '/images/categories/facials.webp',
    ordering: 1,
    serviceCount: 4,
  },
  {
    id: 'waxing',
    name: 'Waxing',
    slug: 'waxing',
    description: 'Smooth, salon-grade waxing at home',
    image: '/images/categories/waxing.webp',
    ordering: 2,
    serviceCount: 4,
  },
  {
    id: 'manicure-pedicure',
    name: 'Manicure & Pedicure',
    slug: 'manicure-pedicure',
    description: 'Nail, hand and foot care',
    image: '/images/categories/manicure-pedicure.webp',
    ordering: 3,
    serviceCount: 4,
  },
  {
    id: 'clean-ups',
    name: 'Clean-Ups',
    slug: 'clean-ups',
    description: 'Express skincare cleanups',
    image: '/images/categories/clean-ups.webp',
    ordering: 4,
    serviceCount: 0,
  },
  {
    id: 'bleach',
    name: 'Bleach',
    slug: 'bleach',
    description: 'Skin brightening bleach services',
    image: '/images/categories/bleach.webp',
    ordering: 5,
    serviceCount: 0,
  },
  {
    id: 'de-tan-pack',
    name: 'De-Tan Packs',
    slug: 'de-tan-pack',
    description: 'De-tan and glow packs',
    image: '/images/categories/de-tan-pack.webp',
    ordering: 6,
    serviceCount: 0,
  },
  {
    id: 'threading',
    name: 'Threading',
    slug: 'threading',
    description: 'Precise threading services',
    image: '/images/categories/threading.webp',
    ordering: 7,
    serviceCount: 0,
  },
  {
    id: 'body-polishing-massage',
    name: 'Body Polishing & Massage',
    slug: 'body-polishing-massage',
    description: 'Relaxing body polishing and massage rituals',
    image: '/images/categories/body-polishing-massage.webp',
    ordering: 8,
    serviceCount: 0,
  },
] as const;

const SERVICES = [
  // Facials
  { id: 'svc-facial-clarifying', categorySlug: 'facials', name: 'Clarifying Facial', priceFrom: 999, durationMinutes: 45 },
  { id: 'svc-facial-hydra', categorySlug: 'facials', name: 'Hydra Glow Facial', priceFrom: 1299, durationMinutes: 45 },
  { id: 'svc-facial-gold', categorySlug: 'facials', name: 'Gold Radiance Facial', priceFrom: 1799, durationMinutes: 60 },
  { id: 'svc-facial-anti-aging', categorySlug: 'facials', name: 'Anti-Aging Facial', priceFrom: 2199, durationMinutes: 60 },
  // Waxing
  { id: 'svc-wax-full-arms', categorySlug: 'waxing', name: 'Full Arms Waxing', priceFrom: 299, durationMinutes: 20 },
  { id: 'svc-wax-full-legs', categorySlug: 'waxing', name: 'Full Legs Waxing', priceFrom: 499, durationMinutes: 30 },
  { id: 'svc-wax-underarms', categorySlug: 'waxing', name: 'Underarms Waxing', priceFrom: 149, durationMinutes: 15 },
  { id: 'svc-wax-full-body', categorySlug: 'waxing', name: 'Full Body Waxing', priceFrom: 1499, durationMinutes: 120 },
  // Mani-Pedi
  { id: 'svc-manicure-classic', categorySlug: 'manicure-pedicure', name: 'Classic Manicure', priceFrom: 499, durationMinutes: 30 },
  { id: 'svc-pedicure-classic', categorySlug: 'manicure-pedicure', name: 'Classic Pedicure', priceFrom: 599, durationMinutes: 45 },
  { id: 'svc-mani-pedi-combo', categorySlug: 'manicure-pedicure', name: 'Manicure + Pedicure Combo', priceFrom: 999, durationMinutes: 75 },
  { id: 'svc-paraffin-pedicure', categorySlug: 'manicure-pedicure', name: 'Paraffin Pedicure', priceFrom: 799, durationMinutes: 60 },
];

function isoInDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

const PROMOTIONS = [
  {
    id: 'promo-smoke-percent',
    title: 'Monsoon Glow',
    subtitle: 'Flat 30% off facials',
    description: '30% off on all facial services this week.',
    image: '/images/promotions/monsoon-glow.webp',
    ctaText: 'Book Now',
    ctaLink: '/services?category=facials',
    bgColor: '#E0F7FA',
    ordering: 1,
    isActive: true,
    discountType: 'percent',
    discountValue: 30,
    promoCode: 'GLOW30',
    validUntil: isoInDays(14),
  },
  {
    id: 'promo-smoke-flat',
    title: 'First Booking',
    subtitle: 'Rs 500 off your first booking',
    description: 'Welcome offer — Rs 500 off on bookings over Rs 1500.',
    image: '/images/promotions/first-booking.webp',
    ctaText: 'Claim',
    ctaLink: '/services',
    bgColor: '#FFF3E0',
    ordering: 2,
    isActive: true,
    discountType: 'flat',
    discountValue: 500,
    promoCode: 'FIRST500',
    validUntil: isoInDays(30),
  },
  {
    id: 'promo-smoke-dod',
    title: 'Deal of the Day',
    subtitle: 'Classic Pedicure at Rs 499',
    description: '24h flash price on classic pedicure. Today only.',
    image: '/images/promotions/deal-of-day.webp',
    ctaText: 'Grab Now',
    ctaLink: '/services/svc-pedicure-classic',
    bgColor: '#FCE4EC',
    ordering: 3,
    isActive: true,
    dealOfDay: true,
    discountType: 'flat',
    discountValue: 100,
    promoCode: 'DOD100',
    validUntil: isoInDays(7),
  },
];

const PUNE_SPAS = [
  { id: 'spa-serenity-koregaon', name: 'Serenity Spa Koregaon Park', featuredRank: 1 },
  { id: 'spa-lumiere-kothrud', name: 'Lumière Beauty Studio Kothrud', featuredRank: 2 },
  { id: 'spa-blush-baner', name: 'Blush Salon Baner', featuredRank: 3 },
  { id: 'spa-glow-wakad', name: 'Glow Studio Wakad', featuredRank: 4 },
  { id: 'spa-aura-viman-nagar', name: 'Aura Spa Viman Nagar', featuredRank: 5 },
  { id: 'spa-essence-hinjewadi', name: 'Essence Wellness Hinjewadi', featuredRank: 6 },
];

const SPA_SERVICE_NAMES = ['Signature Facial', 'Express Manicure', 'Swedish Massage'];

const TRENDING_SEARCHES = [
  { id: 'trending-1', term: 'facial', displayRank: 1 },
  { id: 'trending-2', term: 'waxing', displayRank: 2 },
  { id: 'trending-3', term: 'manicure', displayRank: 3 },
  { id: 'trending-4', term: 'hair spa', displayRank: 4 },
  { id: 'trending-5', term: 'pedicure', displayRank: 5 },
  { id: 'trending-6', term: 'de-tan', displayRank: 6 },
  { id: 'trending-7', term: 'bleach', displayRank: 7 },
  { id: 'trending-8', term: 'threading', displayRank: 8 },
  { id: 'trending-9', term: 'body polishing', displayRank: 9 },
  { id: 'trending-10', term: 'bridal', displayRank: 10 },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
async function seedCollection(
  name: string,
  docs: ReadonlyArray<{ id: string } & Record<string, unknown>>,
): Promise<void> {
  const batch = db.batch();
  for (const { id, ...data } of docs) {
    const ref = db.collection(name).doc(id);
    batch.set(
      ref,
      {
        ...data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // createdAt is only set on first write — merge:true preserves existing.
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await batch.commit();
  // eslint-disable-next-line no-console
  console.log(`[seed] ${name}: upserted ${docs.length}`);
}

async function seedSpasWithServices(): Promise<void> {
  for (const spa of PUNE_SPAS) {
    const spaRef = db.collection('spas').doc(spa.id);
    await spaRef.set(
      {
        ...spa,
        city: 'pune',
        status: 'active',
        slug: spa.id,
        description: `${spa.name} — smoke-seed spa record`,
        rating: { overall: 4.5 + (spa.featuredRank % 3) * 0.1, count: 100 + spa.featuredRank * 7 },
        priceRange: { min: 499, max: 2999 },
        categories: ['facials', 'waxing', 'manicure-pedicure'],
        amenities: ['parking', 'ac', 'wifi'],
        images: ['/images/spas/placeholder.webp'],
        location: { city: 'pune', state: 'Maharashtra', timezone: 'Asia/Kolkata' },
        contact: { phone: '+91 9000000000', email: 'hello@glamornate.com' },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Nested services subcollection: 3 per spa.
    const batch = db.batch();
    SPA_SERVICE_NAMES.forEach((name, idx) => {
      const sid = `svc-${idx + 1}`;
      batch.set(
        spaRef.collection('services').doc(sid),
        {
          name,
          basePrice: 799 + idx * 200,
          durationMinutes: 30 + idx * 15,
          isActive: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
    await batch.commit();
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] spas: upserted ${PUNE_SPAS.length} with nested services`);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[seed] Project: ${projectId}. Proceeding with merge seed.`);

  // categories
  await seedCollection(
    'categories',
    CATEGORIES.map((c) => ({ ...c })),
  );

  // services (root `services` collection mirrors the frontend catalog flat list)
  await seedCollection(
    'services',
    SERVICES.map((s) => ({
      ...s,
      slug: s.id,
      isActive: true,
      currency: 'INR',
      image: `/images/services/${s.categorySlug}.webp`,
    })),
  );

  // promotions
  await seedCollection('promotions', PROMOTIONS);

  // spas + nested services
  await seedSpasWithServices();

  // trending
  await seedCollection('trendingSearches', TRENDING_SEARCHES);

  // eslint-disable-next-line no-console
  console.log('[seed] Done.');
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[seed] Fatal error:', error);
  process.exit(1);
});
