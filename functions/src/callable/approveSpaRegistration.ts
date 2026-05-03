import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';

const db = admin.firestore();

const ApproveSpaRegistrationSchema = z.object({
  spaId: z.string().min(1),
});

type ApproveSpaRegistrationInput = z.infer<typeof ApproveSpaRegistrationSchema>;

/**
 * Admin-only callable that approves a pending spa registration.
 *
 * On approval it:
 *   1. Elevates the applicant's role to 'spa_owner' and writes spaData.
 *   2. Sets the spa document status to 'active' and records approvedAt.
 *   3. Marks the registrationRequest document status as 'approved'.
 *   4. Writes an audit log entry.
 */
export const approveSpaRegistration = callableOpts({ maxInstances: 5 }).https.onCall(
  withRateLimit(
    { name: 'approveSpaRegistration', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const validated: ApproveSpaRegistrationInput = ApproveSpaRegistrationSchema.parse(data);
    const { spaId } = validated;
    const adminUserId = context.auth.uid;

    // Verify caller is an admin
    const adminDoc = await db.collection('users').doc(adminUserId).get();
    const adminUser = adminDoc.data();

    if (!adminUser || adminUser.role !== 'admin') {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only admins can approve spa registrations',
      );
    }

    // Load the registration request
    const requestRef = db.collection('registrationRequests').doc(spaId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Registration request not found');
    }

    const request = requestDoc.data()!;

    if (request.status !== 'pending_review') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Registration request is already in status '${request.status}'`,
      );
    }

    const { userId } = request;

    // Load the spa document to confirm it exists and is still pending
    const spaRef = db.collection('spas').doc(spaId);
    const spaDoc = await spaRef.get();

    if (!spaDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Spa document not found');
    }

    const spa = spaDoc.data()!;

    if (spa.status !== 'pending') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Spa is already in status '${spa.status}'`,
      );
    }

    const now = admin.firestore.Timestamp.now();

    // Run all three mutations atomically
    const batch = db.batch();

    // 1. Elevate user role to spa_owner
    const userRef = db.collection('users').doc(userId);
    batch.update(userRef, {
      role: 'spa_owner',
      spaData: {
        spaId,
        permissions: ['full_access'],
        commissionRate: spa.commission?.platformPercentage ?? 20,
      },
      updatedAt: now,
    });

    // 2. Activate the spa
    batch.update(spaRef, {
      status: 'active',
      'verification.approvedAt': now,
      isActive: true,
      updatedAt: now,
    });

    // 3. Mark request approved
    batch.update(requestRef, {
      status: 'approved',
      approvedAt: now,
      approvedBy: adminUserId,
    });

    await batch.commit();

    // Write audit log outside the batch (non-critical)
    await db.collection('audit_logs').add({
      userId: adminUserId,
      action: 'spa_registration_approved',
      entity: {
        type: 'spa',
        id: spaId,
      },
      before: { status: 'pending' },
      after: { status: 'active', ownerId: userId },
      ipAddress: context.rawRequest.ip,
      userAgent: context.rawRequest.headers['user-agent'],
      timestamp: now,
    });

    return {
      success: true,
      spaId,
      message: 'Spa registration approved. Owner role has been granted.',
    };

  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
