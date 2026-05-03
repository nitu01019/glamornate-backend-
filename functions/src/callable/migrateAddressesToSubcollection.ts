import * as functions from 'firebase-functions';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import { migrateOne } from '../utils/addresses';
import { writeAuditLog } from '../utils/audit-log';

const logger = createLogger('migrateAddressesToSubcollection');

/**
 * `migrateAddressesToSubcollection` — one-shot per-user migration
 * from `users/{uid}.addresses[]` inline array to the subcollection
 * `users/{uid}/addresses/{addressId}`.
 *
 * Two-phase + idempotent — see `utils/addresses.ts#migrateOne`:
 *   Phase A: write every legacy entry to the subcollection.
 *   Phase B: clear the inline array from the user doc.
 *
 * A subsequent invocation returns `{ migrated: N, alreadyDone: true }`
 * without touching anything.
 *
 * The frontend triggers this lazily on first app open after deploy
 * (detects missing `addressCount` on the user doc). It can also be
 * invoked manually via `firebase functions:shell`.
 */
export const migrateAddressesToSubcollection = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'migrateAddressesToSubcollection', windowMs: 60_000, max: 30 },
    async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Authentication required',
      );
    }

    const uid = context.auth.uid;

    try {
      const result = await migrateOne(uid);
      logger.info('Migration complete', {
        uid,
        migrated: result.migrated,
        alreadyDone: result.alreadyDone,
      });

      // S4: Audit log — one-shot migration. We only record if the
      // migration actually did work (migrated > 0 OR alreadyDone) so
      // noisy no-op calls from the frontend's lazy check don't flood
      // the audit_logs collection.
      if (result.migrated > 0 || result.alreadyDone === false) {
        try {
          await writeAuditLog({
            userId: uid,
            action: 'addresses.migrated_to_subcollection',
            entity: { type: 'user', id: uid },
            metadata: {
              migrated: result.migrated,
              alreadyDone: result.alreadyDone,
            },
          });
        } catch (auditError) {
          logger.warn('writeAuditLog failed (migrateAddresses)', auditError);
        }
      }

      return result;
    } catch (error) {
      logger.error('Migration failed', error);
      throw handleError(error);
    }
  },
  ),
);
