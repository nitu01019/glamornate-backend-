import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import { addressPaths, writeUserAddressSummary } from '../utils/addresses';
import { writeAuditLog } from '../utils/audit-log';

const logger = createLogger('setDefaultAddress');

const SetDefaultAddressSchema = z.object({
  addressId: z.string().trim().min(1).max(128),
});

/**
 * `setDefaultAddress` — atomically flip which address is the user's
 * default. Demotes every other address's `isDefault` flag inside the
 * same transaction so the "exactly one default" invariant holds.
 *
 * Idempotent: calling it for an address that is already default
 * is a no-op and returns success.
 */
export const setDefaultAddress = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'setDefaultAddress', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication required',
    );
  }

  const uid = context.auth.uid;

  try {
    const input = SetDefaultAddressSchema.parse(data);
    const db = admin.firestore();

    const result = await db.runTransaction(async (tx) => {
      const subcolRef = db.collection(addressPaths.subcollection(uid));
      const allSnap = await tx.get(subcolRef);

      const target = allSnap.docs.find((d) => d.id === input.addressId);
      if (!target) {
        throw new functions.https.HttpsError(
          'not-found',
          'address/not-found',
          { addressId: input.addressId },
        );
      }

      const now = admin.firestore.FieldValue.serverTimestamp();

      for (const doc of allSnap.docs) {
        const shouldBeDefault = doc.id === input.addressId;
        const currentlyDefault = doc.data().isDefault === true;
        if (currentlyDefault !== shouldBeDefault) {
          tx.update(doc.ref, {
            isDefault: shouldBeDefault,
            updatedAt: now,
          });
        }
      }

      writeUserAddressSummary(tx, db, uid, input.addressId, allSnap.size);

      return { addressId: input.addressId };
    });

    logger.info('setDefaultAddress success', {
      uid,
      addressId: result.addressId,
    });

    // S4: Audit log — records the new default pointer. Tracking this
    // prevents disputes about which address was in effect at the time
    // of a booking.
    try {
      await writeAuditLog({
        userId: uid,
        action: 'address.default_changed',
        entity: { type: 'address', id: result.addressId },
        after: { isDefault: true },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (setDefaultAddress)', auditError);
    }

    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'address/invalid-input',
        { errors: error.errors },
      );
    }
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw handleError(error);
  }
    },
  ),
);
