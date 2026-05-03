import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { sanitizeInput } from '../utils/validator';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

const SpaRegistrationSchema = z.object({
  name: z.string().min(3).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(10).max(2000),
  shortDescription: z.string().min(10).max(200),
  location: z.object({
    address: z.string(),
    city: z.string(),
    state: z.string(),
    pincode: z.string(),
    geo: z.object({
      lat: z.number(),
      lng: z.number(),
    }),
    timezone: z.string(),
  }),
  contact: z.object({
    phone: z.string(),
    email: z.string().email(),
    whatsapp: z.string().optional(),
  }),
  categories: z.array(z.enum(['massage', 'facial', 'body', 'pedicure', 'manicure', 'wellness'])),
  amenities: z.array(z.enum(['parking', 'wifi', 'shower', 'locker', 'ac', 'robes', 'refreshments'])),
  operatingHours: z.object({
    mon: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
    tue: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
    wed: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
    thu: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
    fri: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
    sat: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
    sun: z.object({ open: z.string(), close: z.string(), isOpen: z.boolean() }),
  }),
  images: z.array(z.string()).optional(),
  documents: z.array(z.object({
    type: z.enum(['pan', 'gst', 'proof_of_business', 'identity_proof']),
    url: z.string(),
  })),
});

type SpaRegistrationInput = z.infer<typeof SpaRegistrationSchema>;

export const submitSpaRegistration = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'submitSpaRegistration', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated: SpaRegistrationInput = SpaRegistrationSchema.parse(data);

    // Check if user can register as spa owner
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.data();

    if (user?.role !== 'spa_owner' && user?.role !== 'customer') {
      throw new functions.https.HttpsError('permission-denied', 'User role not suitable for spa registration');
    }

    // Check if slug is unique
    const existingSlugDoc = await db.collection('spas').where('slug', '==', validated.slug).get();
    if (!existingSlugDoc.empty) {
      throw new functions.https.HttpsError('already-exists', 'This slug is already in use');
    }

    // Check if user already has a spa
    if (user?.spaData?.spaId) {
      throw new functions.https.HttpsError('already-exists', 'User already owns a spa');
    }

    const now = admin.firestore.Timestamp.now();

    const sanitizedName = sanitizeInput(validated.name);
    const sanitizedDescription = sanitizeInput(validated.description);
    const sanitizedShortDescription = sanitizeInput(validated.shortDescription);

    // Create spa
    const spaData = {
      name: sanitizedName,
      slug: validated.slug,
      description: sanitizedDescription,
      shortDescription: sanitizedShortDescription,
      location: validated.location,
      contact: validated.contact,
      categories: validated.categories,
      amenities: validated.amenities,
      operatingHours: validated.operatingHours,
      gallery: validated.images || [],
      rating: {
        overall: 0,
        count: 0,
        breakdown: { ambiance: 0, service: 0, therapist: 0, hygiene: 0 },
      },
      tier: 'basic' as const,
      commission: {
        platformPercentage: 20,
        fixedFee: 0,
      },
      status: 'pending' as const,
      verification: {
        submittedAt: now,
        approvedAt: null,
        documents: validated.documents || [],
      },
      statistics: {
        totalBookings: 0,
        revenue: 0,
      },
      seo: {
        metaTitle: `${sanitizedName} | Glamornate`,
        metaDescription: sanitizedShortDescription,
      },
      searchIndex: `${sanitizedName} ${validated.location.city} ${validated.categories.join(' ')}`.toLowerCase(),
      isActive: false,
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    };

    const spaRef = await db.collection('spas').add(spaData);

    // Record the registration request for admin review.
    // The user's role stays 'customer' until an admin explicitly approves
    // the request via approveSpaRegistration.
    await db.collection('registrationRequests').doc(spaRef.id).set({
      userId,
      spaId: spaRef.id,
      status: 'pending_review',
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Create audit log
    await db.collection('audit_logs').add({
      userId,
      action: 'spa_registration',
      entity: {
        type: 'spa',
        id: spaRef.id,
      },
      before: null,
      after: { id: spaRef.id, name: sanitizedName },
      ipAddress: context.rawRequest.ip,
      userAgent: context.rawRequest.headers['user-agent'],
      timestamp: now,
    });

    return {
      success: true,
      spaId: spaRef.id,
      status: 'pending',
      message: 'Spa registration submitted. Your application is under review.',
    };

  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
