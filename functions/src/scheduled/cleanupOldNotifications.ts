import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

const db = admin.firestore();

/**
 * Nightly cleanup of notifications.
 *
 * Two branches run in the same pass:
 *   1. Expired branch — every notification with `expiresAt <= now` is
 *      DELETED. This is how broadcast notifications with a 30-day TTL
 *      stop bloating the feed and how trigger-side notifications can opt
 *      in to a custom TTL by writing `expiresAt`.
 *   2. Age branch — any notification still unread after 30 days is
 *      force-marked read so it stops counting against the unread badge.
 *      This matches the original behaviour of this function.
 *
 * Both branches paginate in chunks of 1000 and commit in sub-batches of
 * 500 to respect the Firestore write-batch limit.
 */
export const cleanupOldNotifications = functions.pubsub
  .schedule('0 0 * * *')
  .onRun(async () => {
    functions.logger.info('Cleaning up notifications...');

    const now = admin.firestore.Timestamp.now();
    const thirtyDaysAgo = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    );

    // -----------------------------------------------------------------
    // Branch 1 — delete expired notifications (expiresAt <= now)
    // -----------------------------------------------------------------
    let expiredDeleted = 0;
    try {
      const expiredSnap = await db
        .collection('notifications')
        .where('expiresAt', '<=', now)
        .limit(1000)
        .get();

      let batch = db.batch();
      let ops = 0;
      for (const doc of expiredSnap.docs) {
        batch.delete(doc.ref);
        ops++;
        expiredDeleted++;
        if (ops >= 500) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
      if (ops > 0) {
        await batch.commit();
      }
    } catch (error) {
      // If the `expiresAt` index is missing or the field is absent on every
      // doc, Firestore will still succeed with an empty result set. We log
      // but do NOT fail the scheduled job — the age branch must still run.
      functions.logger.warn('expiresAt branch skipped', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // -----------------------------------------------------------------
    // Branch 2 — mark unread notifications older than 30 days as read
    // -----------------------------------------------------------------
    const oldNotifications = await db
      .collection('notifications')
      .where('createdAt', '<', thirtyDaysAgo)
      .where('read', '==', false)
      .limit(1000)
      .get();

    let markedCount = 0;
    let ageBatch = db.batch();
    let ageOps = 0;

    for (const doc of oldNotifications.docs) {
      ageBatch.update(doc.ref, {
        read: true,
        readAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      markedCount++;
      ageOps++;

      if (ageOps >= 500) {
        await ageBatch.commit();
        ageBatch = db.batch();
        ageOps = 0;
      }
    }

    if (ageOps > 0) {
      await ageBatch.commit();
    }

    functions.logger.info('Notifications cleanup completed', {
      expiredDeleted,
      markedAsRead: markedCount,
      ageSample: oldNotifications.size,
    });

    return null;
  });
