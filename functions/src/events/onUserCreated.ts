import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { createLogger } from '../utils/logger';

const db = admin.firestore();
const logger = createLogger('onUserCreated');

/**
 * Minimal zod schema covering only the fields this handler reads from the
 * user doc. `.passthrough()` keeps unknown fields. A malformed doc is logged
 * and the trigger exits early instead of crashing on `.field.foo` access.
 */
const UserDocSchema = z
  .object({
    email: z.string().optional(),
    role: z.string().optional(),
    authProvider: z.string().optional(),
    profile: z
      .object({
        email: z.string().optional(),
      })
      .passthrough()
      .optional(),
    spaData: z
      .object({
        spaId: z.string().optional(),
        permissions: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Triggered when a new user document is created
 * Creates wallet, sends welcome, initializes preferences
 */
export const onUserCreated = functions.firestore
  .document('users/{userId}')
  .onCreate(async (snap, context) => {
    const raw = snap.data();
    const { userId } = context.params;

    if (!raw) {
      logger.warn('User created trigger fired but snapshot data is null', { userId });
      return null;
    }

    const parsed = UserDocSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error('[onUserCreated] malformed user doc', {
        userId,
        error: parsed.error.flatten(),
      });
      return null;
    }
    const user = parsed.data;

    const userEmail = user.profile?.email || user.email;
    logger.info('User created', { userId, email: userEmail, role: user.role });

    const batch = db.batch();

    // 1. Create wallet for new user
    const walletRef = db.collection('wallets').doc(userId);
    batch.set(walletRef, {
      userId,
      currency: 'INR',
      balance: {
        current: 0,
        credited: 0,
        debited: 0,
      },
      transactions: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2. Send welcome notification (if email is provided)
    if (userEmail) {
      const notificationRef = db.collection('notifications').doc();
      batch.set(notificationRef, {
        userId,
        type: 'welcome',
        title: 'Welcome to Glamornate!',
        body: 'Discover and book the best spa and massage experiences near you.',
        data: {
          type: 'onboarding',
          isFirstLogin: true,
        },
        read: false,
        deliveryStatus: 'delivered',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        channels: {
          push: true,
          email: true,
          sms: false,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // 3. Create audit log
    const auditLogRef = db.collection('audit_logs').doc();
    batch.set(auditLogRef, {
      userId,
      action: 'user_created',
      entity: {
        type: 'user',
        id: userId,
      },
      before: null,
      after: {
        email: userEmail,
        role: user.role,
        authProvider: user.authProvider,
      },
      ipAddress: null,
      userAgent: null,
      metadata: {
        spaId: user.spaData?.spaId,
        permissions: user.spaData?.permissions,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // 4. If spa owner, create initial spa registration prompt
    if (user.role === 'spa_owner' && !user.spaData?.spaId) {
      await db.collection('notifications').add({
        userId,
        type: 'spa_onboarding',
        title: 'Complete Your Spa Registration',
        body: 'Let\'s set up your spa profile to start receiving bookings.',
        data: {
          type: 'spa_onboarding',
          step: 'registration',
        },
        read: false,
        deliveryStatus: 'delivered',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        channels: { push: true, email: true, sms: false },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    logger.info('User onboarding completed', { userId });

    return null;
  });
