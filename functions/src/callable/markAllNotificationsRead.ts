import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';

const db = admin.firestore();
const logger = createLogger('markAllNotificationsRead');

export const markAllNotificationsRead = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'markAllNotificationsRead', windowMs: 60_000, max: 30 },
    async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const snapshot = await db
      .collection('notifications')
      .where('userId', '==', userId)
      .where('read', '==', false)
      .get();

    if (snapshot.empty) {
      return { success: true, updated: 0 };
    }

    const batch = db.batch();
    const now = new Date().toISOString();

    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { read: true, readAt: now });
    });

    await batch.commit();

    // S4: Audit log — bulk read state changes. Useful for distinguishing
    // deliberate "mark all read" actions from individual reads when
    // investigating missed-notification complaints.
    try {
      await writeAuditLog({
        userId,
        action: 'notifications.mark_all_read',
        entity: { type: 'notifications', id: userId },
        metadata: { updated: snapshot.size },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (markAllNotificationsRead)', auditError);
    }

    return {
      success: true,
      updated: snapshot.size,
    };
  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
