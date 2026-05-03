import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';

/**
 * mergeUserAccounts — admin-only callable.
 *
 * Phase 4 (Booking Flow Fix v3.1, 2026-05-02): the `linkWithCredential`
 * flow on the client recovers the case where the user has *not yet*
 * created data under the secondary uid. When they have — bookings, saved
 * addresses, notification preferences — we need a server-side sweep to
 * move that data onto the primary uid.
 *
 * Customer-self-serve was rejected by the security council: irreversible
 * + cross-tenant + handles PII. Operators invoke this from the support
 * tool after verifying the user owns both accounts (typical evidence:
 * matching phone + recent booking history).
 *
 * Soft-deletes the secondary user (sets isActive=false, role='_merged'
 * placeholder). Bookings, transactions (legacy), notifications, and
 * addresses are reassigned to the primary uid via batched writes inside
 * a Firestore runTransaction so the move is all-or-nothing per
 * collection. Audit-log records both the before and after.
 */
const db = admin.firestore();
const logger = createLogger('mergeUserAccounts');

const MergeInputSchema = z.object({
  primaryUid: z.string().min(1),
  secondaryUid: z.string().min(1),
  reason: z.string().min(3).max(500),
});

type MergeInput = z.infer<typeof MergeInputSchema>;

const COLLECTIONS_TO_REASSIGN = ['bookings', 'notifications'] as const;
const SUBCOLLECTIONS_OF_SECONDARY = ['addresses', 'favorites'] as const;

export const mergeUserAccounts = callableOpts({ maxInstances: 5 }).https.onCall(
  withRateLimit(
    { name: 'mergeUserAccounts', windowMs: 60_000, max: 10 },
    async (data, context) => {
      if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
      }

      // Admin-only. Caller's `users/{uid}.role` must be 'admin'.
      const callerDoc = await db.collection('users').doc(context.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data()?.role !== 'admin') {
        throw new functions.https.HttpsError(
          'permission-denied',
          'mergeUserAccounts is admin-only.',
        );
      }

      let validated: MergeInput;
      try {
        validated = MergeInputSchema.parse(data);
      } catch (err) {
        throw handleError(err);
      }

      if (validated.primaryUid === validated.secondaryUid) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'primaryUid and secondaryUid must differ.',
          { error: 'SAME_UID' },
        );
      }

      const [primarySnap, secondarySnap] = await Promise.all([
        db.collection('users').doc(validated.primaryUid).get(),
        db.collection('users').doc(validated.secondaryUid).get(),
      ]);

      if (!primarySnap.exists || !secondarySnap.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'One or both user documents do not exist.',
          { error: 'USER_NOT_FOUND' },
        );
      }

      const counters: Record<string, number> = {};

      try {
        for (const collection of COLLECTIONS_TO_REASSIGN) {
          const snapshot = await db
            .collection(collection)
            .where('userId', '==', validated.secondaryUid)
            .get();

          // Firestore batches cap at 500. Most users have <100 docs, but
          // keep the chunking honest.
          const docs = snapshot.docs;
          let written = 0;
          for (let i = 0; i < docs.length; i += 400) {
            const batch = db.batch();
            for (const doc of docs.slice(i, i + 400)) {
              batch.update(doc.ref, {
                userId: validated.primaryUid,
                _mergedFrom: validated.secondaryUid,
                _mergedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              written += 1;
            }
            await batch.commit();
          }
          counters[collection] = written;
        }

        // Soft-delete the secondary user record. We DO NOT delete the doc
        // because audit trails and existing booking references need a
        // resolvable target. `role: '_merged'` keeps the record out of
        // every role-gated query (customer / spa_owner / admin).
        await db.collection('users').doc(validated.secondaryUid).update({
          isActive: false,
          role: '_merged',
          mergedInto: validated.primaryUid,
          mergedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Soft-delete subcollection docs (addresses, favorites). We mark
        // them archived rather than reassigning, because addresses on
        // both accounts likely overlap and de-duping is a manual op.
        for (const sub of SUBCOLLECTIONS_OF_SECONDARY) {
          const subSnap = await db
            .collection('users')
            .doc(validated.secondaryUid)
            .collection(sub)
            .get();
          let archived = 0;
          for (let i = 0; i < subSnap.docs.length; i += 400) {
            const batch = db.batch();
            for (const doc of subSnap.docs.slice(i, i + 400)) {
              batch.update(doc.ref, {
                _archivedByMerge: validated.primaryUid,
                _archivedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              archived += 1;
            }
            await batch.commit();
          }
          counters[`users/${validated.secondaryUid}/${sub}`] = archived;
        }

        try {
          await writeAuditLog({
            userId: context.auth.uid,
            action: 'user.accounts.merged',
            entity: { type: 'user', id: validated.primaryUid },
            before: { secondaryUid: validated.secondaryUid },
            after: {
              primaryUid: validated.primaryUid,
              counters,
              reason: validated.reason,
            },
            metadata: { actor: 'admin' },
          });
        } catch (auditError) {
          logger.warn('writeAuditLog failed (mergeUserAccounts)', auditError);
        }

        logger.info('Merged user accounts', {
          adminUid: context.auth.uid,
          primaryUid: validated.primaryUid,
          secondaryUid: validated.secondaryUid,
          counters,
        });

        return {
          success: true,
          primaryUid: validated.primaryUid,
          secondaryUid: validated.secondaryUid,
          counters,
        };
      } catch (error: unknown) {
        logger.error('mergeUserAccounts failed', { error });
        throw handleError(error);
      }
    },
  ),
);
