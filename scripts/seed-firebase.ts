/**
 * Firebase Seed Data Script
 *
 * Populates Firebase Firestore with sample data + creates 3 test users
 * (customer, spa-owner, admin) with hardcoded passwords. Intended for
 * local dev / emulator only — DO NOT run against production.
 *
 * Guards (must all pass or script aborts):
 *   - `FIREBASE_PROJECT_ID` (or NEXT_PUBLIC_FIREBASE_PROJECT_ID) MUST be set
 *   - Project MUST NOT equal the production project (`glamornate-758c6`).
 *     Use the Firebase emulator or a separate dev project.
 *   - `CONFIRM_DEV_SEED` MUST equal `yes` (acknowledges hardcoded test
 *     credentials are about to be created).
 *
 * Usage (emulator):
 *   FIREBASE_PROJECT_ID=demo-glamornate \
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   CONFIRM_DEV_SEED=yes \
 *     npx ts-node scripts/seed-firebase.ts
 */

// ---------------------------------------------------------------------------
// Env guards — defense against accidental prod seed
// ---------------------------------------------------------------------------
const PROD_PROJECT = 'glamornate-758c6';
const targetProject =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  '';
const confirm = process.env.CONFIRM_DEV_SEED;

if (!targetProject) {
  // eslint-disable-next-line no-console
  console.error(
    '[seed-firebase] Aborted: FIREBASE_PROJECT_ID (or NEXT_PUBLIC_FIREBASE_PROJECT_ID) must be set.',
  );
  process.exit(1);
}
if (targetProject === PROD_PROJECT) {
  // eslint-disable-next-line no-console
  console.error(
    `[seed-firebase] Aborted: refusing to seed against production project "${PROD_PROJECT}". This script creates hardcoded-password test accounts and is dev-only. Use the emulator (FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST) or a non-prod project.`,
  );
  process.exit(1);
}
if (confirm !== 'yes') {
  // eslint-disable-next-line no-console
  console.error(
    '[seed-firebase] Aborted: CONFIRM_DEV_SEED must equal "yes" to acknowledge this script creates known-password test accounts (customer / spa-owner / admin).',
  );
  process.exit(1);
}

import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth';

// Firebase config - load from environment
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
  projectId: targetProject,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ============================================================================
// SEED DATA
// ============================================================================
// All values below are SYNTHETIC TEST FIXTURES — bank account numbers,
// IFSC codes, addresses, and personal details are NOT real. Used for
// dev/emulator seeding only.
// ============================================================================

const SPAS = [
  {
    name: 'Serenity Spa & Wellness',
    slug: 'serenity-spa-wellness',
    description:
      'A premium spa offering a wide range of wellness treatments, massages, and beauty services in a tranquil environment.',
    shortDescription: 'Premium wellness treatments in a tranquil setting',
    featuredImage:
      'https://images.unsplash.com/photo-1540555700478-4be289fbecef?w=800',
    gallery: [
      'https://images.unsplash.com/photo-1540555700478-4be289fbecef?w=800',
      'https://images.unsplash.com/photo-1515377905703-c4788e89af14?w=800',
      'https://images.unsplash.com/photo-1600334044596-ff83365265a2?w=800',
    ],
    location: {
      address: '123 Wellness Avenue',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      geo: { lat: 19.076, lng: 72.8777 },
      timezone: 'Asia/Kolkata',
    },
    contact: {
      phone: '+91 9000000000',
      email: 'contact@serenityspa.com',
      website: 'https://serenityspa.com',
    },
    categories: ['massage', 'facial', 'wellness'],
    amenities: ['parking', 'wifi', 'shower', 'ac', 'refreshments'],
    rating: {
      overall: 4.8,
      count: 245,
      breakdown: { ambiance: 4.9, service: 4.8, hygiene: 4.9, therapist: 4.7 },
    },
    tier: 'premium',
    commission: { platformPercentage: 15, fixedFee: 50 },
    payout: {
      bankAccount: {
        accountNumber: 'TEST-XXXX1234',
        ifsc: 'TEST-SBIN0001234',
        accountName: 'Serenity Spa Pvt Ltd',
      },
      payoutFrequency: 'weekly',
    },
    operatingHours: {
      monday: { open: '09:00', close: '21:00', isOpen: true },
      tuesday: { open: '09:00', close: '21:00', isOpen: true },
      wednesday: { open: '09:00', close: '21:00', isOpen: true },
      thursday: { open: '09:00', close: '21:00', isOpen: true },
      friday: { open: '09:00', close: '21:00', isOpen: true },
      saturday: { open: '10:00', close: '22:00', isOpen: true },
      sunday: { open: '10:00', close: '20:00', isOpen: true },
    },
    status: 'active',
    statistics: {
      totalBookings: 1250,
      revenue: 1875000,
      averageRating: 4.8,
      activeStaff: 8,
    },
    seo: {
      metaTitle: 'Serenity Spa - Premium Wellness Treatments in Mumbai',
      metaDescription:
        'Experience luxury spa treatments, massages, and wellness therapies at Serenity Spa.',
      keywords: ['spa', 'massage', 'wellness', 'mumbai', 'facial'],
    },
    isActive: true,
    ownerId: 'spa-owner-1',
  },
  {
    name: 'Zen Wellness Center',
    slug: 'zen-wellness-center',
    description:
      'Holistic wellness center specializing in traditional and modern healing therapies.',
    shortDescription: 'Holistic healing and wellness therapies',
    featuredImage:
      'https://images.unsplash.com/photo-1515377905703-c4788e89af14?w=800',
    gallery: [
      'https://images.unsplash.com/photo-1515377905703-c4788e89af14?w=800',
      'https://images.unsplash.com/photo-1540555700478-4be289fbecef?w=800',
    ],
    location: {
      address: '456 Zen Street',
      city: 'Delhi',
      state: 'Delhi',
      pincode: '110001',
      geo: { lat: 28.6139, lng: 77.209 },
      timezone: 'Asia/Kolkata',
    },
    contact: {
      phone: '+91 9000000001',
      email: 'hello@zenwellness.com',
    },
    categories: ['massage', 'wellness', 'body'],
    amenities: ['parking', 'wifi', 'shower', 'locker', 'ac'],
    rating: {
      overall: 4.6,
      count: 189,
      breakdown: { ambiance: 4.7, service: 4.6, hygiene: 4.5, therapist: 4.6 },
    },
    tier: 'premium',
    commission: { platformPercentage: 15, fixedFee: 50 },
    payout: {
      bankAccount: {
        accountNumber: 'XXXX5678',
        ifsc: 'HDFC0005678',
        accountName: 'Zen Wellness Pvt Ltd',
      },
      payoutFrequency: 'weekly',
    },
    operatingHours: {
      monday: { open: '08:00', close: '20:00', isOpen: true },
      tuesday: { open: '08:00', close: '20:00', isOpen: true },
      wednesday: { open: '08:00', close: '20:00', isOpen: true },
      thursday: { open: '08:00', close: '20:00', isOpen: true },
      friday: { open: '08:00', close: '20:00', isOpen: true },
      saturday: { open: '09:00', close: '21:00', isOpen: true },
      sunday: { open: '10:00', close: '18:00', isOpen: true },
    },
    status: 'active',
    statistics: {
      totalBookings: 890,
      revenue: 1234000,
      averageRating: 4.6,
      activeStaff: 6,
    },
    seo: {
      metaTitle: 'Zen Wellness Center - Holistic Healing in Delhi',
      metaDescription:
        'Discover traditional and modern healing therapies at Zen Wellness Center.',
      keywords: ['zen', 'wellness', 'holistic', 'delhi', 'healing'],
    },
    isActive: true,
    ownerId: 'spa-owner-2',
  },
];

const SERVICES = [
  {
    name: 'Swedish Massage',
    slug: 'swedish-massage',
    category: 'massage',
    description:
      'A relaxing full-body massage using long strokes and gentle pressure to promote relaxation and improve circulation.',
    benefits: [
      'Stress relief',
      'Improved circulation',
      'Muscle relaxation',
      'Better sleep',
    ],
    baseDuration: 60,
    durationVariants: [60, 90, 120],
    basePrice: 2500,
    currency: 'INR',
    recommendedFor: 'all',
    tags: ['relaxation', 'stress-relief', 'beginner-friendly'],
    icon: 'massage',
    images: [
      'https://images.unsplash.com/photo-1519823551278-64ac3278e825?w=800',
    ],
    addOns: [
      { name: 'Aromatherapy', price: 500, duration: 15 },
      { name: 'Hot Stones', price: 800, duration: 15 },
    ],
    isActive: true,
    ordering: 1,
  },
  {
    name: 'Deep Tissue Massage',
    slug: 'deep-tissue-massage',
    category: 'massage',
    description:
      'A therapeutic massage targeting deep muscle layers to release chronic tension and knots.',
    benefits: [
      'Chronic pain relief',
      'Muscle tension release',
      'Improved mobility',
      'Injury recovery',
    ],
    baseDuration: 60,
    durationVariants: [60, 90],
    basePrice: 3000,
    currency: 'INR',
    recommendedFor: 'all',
    tags: ['therapeutic', 'pain-relief', 'sports'],
    icon: 'massage',
    images: [
      'https://images.unsplash.com/photo-1519823551278-64ac3278e825?w=800',
    ],
    addOns: [{ name: 'CBD Oil', price: 1000, duration: 0 }],
    isActive: true,
    ordering: 2,
  },
  {
    name: 'Signature Facial',
    slug: 'signature-facial',
    category: 'facial',
    description:
      'A luxurious facial treatment customized for your skin type, including cleansing, exfoliation, and hydration.',
    benefits: ['Deep cleansing', 'Skin rejuvenation', 'Hydration', 'Glow'],
    baseDuration: 45,
    durationVariants: [45, 60, 90],
    basePrice: 3500,
    currency: 'INR',
    recommendedFor: 'all',
    tags: ['skincare', 'anti-aging', 'hydration'],
    icon: 'facial',
    images: [
      'https://images.unsplash.com/photo-1570172619644-dfd03ed35d7f?w=800',
    ],
    addOns: [
      { name: 'Eye Treatment', price: 500, duration: 10 },
      { name: 'Neck & Decollete', price: 400, duration: 10 },
    ],
    isActive: true,
    ordering: 3,
  },
  {
    name: 'Aromatherapy Body Wrap',
    slug: 'aromatherapy-body-wrap',
    category: 'body',
    description:
      'A detoxifying body treatment using essential oils and warm wraps to nourish and rejuvenate your skin.',
    benefits: [
      'Detoxification',
      'Skin nourishment',
      'Relaxation',
      'Aromatherapy benefits',
    ],
    baseDuration: 75,
    durationVariants: [75],
    basePrice: 4500,
    currency: 'INR',
    recommendedFor: 'all',
    tags: ['detox', 'hydration', 'relaxation'],
    icon: 'body',
    images: ['https://images.unsplash.com/photo-1544161515-158527d7b630?w=800'],
    addOns: [],
    isActive: true,
    ordering: 4,
  },
  {
    name: 'Hot Stone Massage',
    slug: 'hot-stone-massage',
    category: 'massage',
    description:
      'A deeply relaxing massage using heated basalt stones to melt away tension and promote deep relaxation.',
    benefits: [
      'Deep relaxation',
      'Muscle tension relief',
      'Improved circulation',
      'Stress relief',
    ],
    baseDuration: 90,
    durationVariants: [90, 120],
    basePrice: 4000,
    currency: 'INR',
    recommendedFor: 'all',
    tags: ['relaxation', 'heat-therapy', 'luxury'],
    icon: 'massage',
    images: [
      'https://images.unsplash.com/photo-1519823551278-64ac3278e825?w=800',
    ],
    addOns: [],
    isActive: true,
    ordering: 5,
  },
  {
    name: 'Manicure & Pedicure',
    slug: 'manicure-pedicure',
    category: 'manicure',
    description:
      'Complete nail care treatment including shaping, cuticle care, massage, and polish application.',
    benefits: ['Nail health', 'Hand/foot care', 'Relaxation', 'Grooming'],
    baseDuration: 60,
    durationVariants: [60, 90],
    basePrice: 1500,
    currency: 'INR',
    recommendedFor: 'all',
    tags: ['nail-care', 'grooming', 'beauty'],
    icon: 'manicure',
    images: [
      'https://images.unsplash.com/photo-1604654894610-df63bc43676e?w=800',
    ],
    addOns: [
      { name: 'Gel Polish', price: 500, duration: 15 },
      { name: 'Nail Art', price: 300, duration: 15 },
    ],
    isActive: true,
    ordering: 6,
  },
];

const THERAPISTS = [
  {
    name: 'Priya Sharma',
    slug: 'priya-sharma',
    displayName: 'Priya',
    photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b59330?w=400',
    spaId: '', // Will be set dynamically
    description:
      'Certified massage therapist with 8+ years of experience in Swedish and deep tissue massage.',
    specialties: [
      'Swedish Massage',
      'Deep Tissue Massage',
      'Hot Stone Massage',
    ],
    certifications: [
      {
        name: 'Certified Massage Therapist',
        issuer: 'International Spa Association',
        issuedDate: '2016-01-15',
        documentUrl: '',
      },
    ],
    yearsOfExperience: 8,
    languages: ['English', 'Hindi'],
    gender: 'female',
    rating: {
      overall: 4.9,
      count: 156,
      breakdown: { ambiance: 0, service: 0, hygiene: 0, therapist: 4.9 },
    },
    status: 'online',
    onLeave: false,
    availability: {
      monday: { open: '09:00', close: '18:00', isOpen: true },
      tuesday: { open: '09:00', close: '18:00', isOpen: true },
      wednesday: { open: '09:00', close: '18:00', isOpen: true },
      thursday: { open: '09:00', close: '18:00', isOpen: true },
      friday: { open: '09:00', close: '18:00', isOpen: true },
      saturday: { open: '10:00', close: '16:00', isOpen: true },
      sunday: { open: '10:00', close: '16:00', isOpen: false },
    },
    commission: { percentage: 30, flatRate: 0 },
    statistics: { totalBookings: 456, revenue: 684000, avgRating: 4.9 },
    isActive: true,
  },
  {
    name: 'Rahul Verma',
    slug: 'rahul-verma',
    displayName: 'Rahul',
    photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400',
    spaId: '', // Will be set dynamically
    description:
      'Expert in therapeutic and sports massage with certification in multiple modalities.',
    specialties: ['Deep Tissue Massage', 'Sports Massage', 'Aromatherapy'],
    certifications: [
      {
        name: 'Sports Massage Specialist',
        issuer: 'National Massage Board',
        issuedDate: '2018-06-20',
        documentUrl: '',
      },
    ],
    yearsOfExperience: 6,
    languages: ['English', 'Hindi', 'Punjabi'],
    gender: 'male',
    rating: {
      overall: 4.7,
      count: 98,
      breakdown: { ambiance: 0, service: 0, hygiene: 0, therapist: 4.7 },
    },
    status: 'online',
    onLeave: false,
    availability: {
      monday: { open: '10:00', close: '19:00', isOpen: true },
      tuesday: { open: '10:00', close: '19:00', isOpen: true },
      wednesday: { open: '10:00', close: '19:00', isOpen: true },
      thursday: { open: '10:00', close: '19:00', isOpen: true },
      friday: { open: '10:00', close: '19:00', isOpen: true },
      saturday: { open: '09:00', close: '20:00', isOpen: true },
      sunday: { open: '09:00', close: '18:00', isOpen: true },
    },
    commission: { percentage: 30, flatRate: 0 },
    statistics: { totalBookings: 312, revenue: 468000, avgRating: 4.7 },
    isActive: true,
  },
  {
    name: 'Anita Patel',
    slug: 'anita-patel',
    displayName: 'Anita',
    photo: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d35?w=400',
    spaId: '', // Will be set dynamically
    description:
      'Skilled esthetician specializing in facial treatments and skincare therapies.',
    specialties: ['Signature Facial', 'Anti-Aging Treatments', 'Skin Analysis'],
    certifications: [
      {
        name: 'Licensed Esthetician',
        issuer: 'Beauty Therapy Institute',
        issuedDate: '2019-03-10',
        documentUrl: '',
      },
    ],
    yearsOfExperience: 5,
    languages: ['English', 'Hindi', 'Gujarati'],
    gender: 'female',
    rating: {
      overall: 4.8,
      count: 134,
      breakdown: { ambiance: 0, service: 0, hygiene: 0, therapist: 4.8 },
    },
    status: 'online',
    onLeave: false,
    availability: {
      monday: { open: '09:00', close: '17:00', isOpen: true },
      tuesday: { open: '09:00', close: '17:00', isOpen: true },
      wednesday: { open: '09:00', close: '17:00', isOpen: true },
      thursday: { open: '09:00', close: '17:00', isOpen: true },
      friday: { open: '09:00', close: '17:00', isOpen: true },
      saturday: { open: '10:00', close: '18:00', isOpen: true },
      sunday: { open: '10:00', close: '16:00', isOpen: false },
    },
    commission: { percentage: 30, flatRate: 0 },
    statistics: { totalBookings: 289, revenue: 433500, avgRating: 4.8 },
    isActive: true,
  },
];

// ============================================================================
// SEED FUNCTIONS
// ============================================================================

async function seedSpas() {
  console.log('Seeding spas...');
  const spaIds: string[] = [];

  for (const spa of SPAS) {
    const docRef = await addDoc(collection(db, 'spas'), {
      ...spa,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    spaIds.push(docRef.id);
    console.log(`  Created spa: ${spa.name} (${docRef.id})`);
  }

  return spaIds;
}

async function seedServices() {
  console.log('Seeding services...');
  const serviceIds: string[] = [];

  for (const service of SERVICES) {
    const docRef = await addDoc(collection(db, 'services'), {
      ...service,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    serviceIds.push(docRef.id);
    console.log(`  Created service: ${service.name} (${docRef.id})`);
  }

  return serviceIds;
}

async function seedTherapists(spaIds: string[]) {
  console.log('Seeding therapists...');
  const therapistIds: string[] = [];

  for (let i = 0; i < THERAPISTS.length; i++) {
    const therapist = THERAPISTS[i];
    const spaId = spaIds[i % spaIds.length]; // Distribute therapists across spas

    const docRef = await addDoc(collection(db, 'therapists'), {
      ...therapist,
      spaId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    therapistIds.push(docRef.id);
    console.log(`  Created therapist: ${therapist.name} (${docRef.id})`);
  }

  return therapistIds;
}

async function createTestUsers() {
  console.log('Creating test users...');

  // Create a test customer
  try {
    const customerUser = await createUserWithEmailAndPassword(
      auth,
      'customer@test.com',
      'test123456'
    );
    await setDoc(doc(db, 'users', customerUser.user.uid), {
      authProvider: 'email',
      role: 'customer',
      profile: {
        displayName: 'Test Customer',
        email: 'customer@test.com',
        phone: '+91 9000000002',
      },
      emailVerified: true,
      phoneVerified: false,
      preferences: {
        language: 'en',
        notifications: { email: true, push: true, sms: false },
      },
      customerData: {
        favorites: [],
        history: [],
      },
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
    console.log('  Created test customer: customer@test.com');
  } catch (error: any) {
    if (error.code === 'auth/email-already-in-use') {
      console.log('  Test customer already exists');
    } else {
      console.error('  Error creating customer:', error.message);
    }
  }

  // Create a test spa owner
  try {
    const spaOwnerUser = await createUserWithEmailAndPassword(
      auth,
      'spaowner@test.com',
      'test123456'
    );
    await setDoc(doc(db, 'users', spaOwnerUser.user.uid), {
      authProvider: 'email',
      role: 'spa_owner',
      profile: {
        displayName: 'Spa Owner',
        email: 'spaowner@test.com',
        phone: '+91 8888888888',
      },
      emailVerified: true,
      phoneVerified: false,
      preferences: {
        language: 'en',
        notifications: { email: true, push: true, sms: true },
      },
      spaData: {
        spaId: '', // Will be updated after spa creation
        permissions: [
          'manage_bookings',
          'manage_staff',
          'manage_services',
          'view_reports',
        ],
        commissionRate: 85,
      },
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
    console.log('  Created test spa owner: spaowner@test.com');
  } catch (error: any) {
    if (error.code === 'auth/email-already-in-use') {
      console.log('  Test spa owner already exists');
    } else {
      console.error('  Error creating spa owner:', error.message);
    }
  }

  // Create a test admin
  try {
    const adminUser = await createUserWithEmailAndPassword(
      auth,
      'admin@test.com',
      'admin123456'
    );
    await setDoc(doc(db, 'users', adminUser.user.uid), {
      authProvider: 'email',
      role: 'admin',
      profile: {
        displayName: 'Admin User',
        email: 'admin@test.com',
      },
      emailVerified: true,
      phoneVerified: false,
      preferences: {
        language: 'en',
        notifications: { email: true, push: true, sms: false },
      },
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
    console.log('  Created test admin: admin@test.com');
  } catch (error: any) {
    if (error.code === 'auth/email-already-in-use') {
      console.log('  Test admin already exists');
    } else {
      console.error('  Error creating admin:', error.message);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('\n========================================');
  console.log('Firebase Seed Data Script');
  console.log('========================================\n');

  if (!firebaseConfig.projectId || !firebaseConfig.apiKey) {
    console.error('Error: Firebase credentials not found.');
    console.log('Please set the following environment variables:');
    console.log('  - NEXT_PUBLIC_FIREBASE_API_KEY');
    console.log('  - NEXT_PUBLIC_FIREBASE_PROJECT_ID');
    console.log(
      '\nYou can also create a .env.local file in frontend/ with these values.'
    );
    process.exit(1);
  }

  console.log('Project ID:', firebaseConfig.projectId);
  console.log('');

  try {
    // Create test users first
    await createTestUsers();

    // Seed core data
    const spaIds = await seedSpas();
    const serviceIds = await seedServices();
    const therapistIds = await seedTherapists(spaIds);

    console.log('\n========================================');
    console.log('Seed completed successfully!');
    console.log('========================================');
    console.log(`Created ${spaIds.length} spas`);
    console.log(`Created ${serviceIds.length} services`);
    console.log(`Created ${therapistIds.length} therapists`);
    console.log('\nTest accounts:');
    console.log('  Customer: customer@test.com / test123456');
    console.log('  Spa Owner: spaowner@test.com / test123456');
    console.log('  Admin: admin@test.com / admin123456');
    console.log('');
  } catch (error) {
    console.error('\nError seeding data:', error);
    process.exit(1);
  }
}

main();
