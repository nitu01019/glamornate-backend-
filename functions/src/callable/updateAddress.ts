import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import {
  AddressPatchSchema,
  addressPaths,
} from '../utils/addresses';
import { writeAuditLog } from '../utils/audit-log';

const logger = createLogger('updateAddress');

const UpdateAddressSchema = z.object({
  addressId: z.string().trim().min(1).max(128),
  patch: AddressPatchSchema,
});

/**
 * `updateAddress` — partial update of a single address. Does NOT touch
 * `isDefault` — callers must use `setDefaultAddress` for that so the
 * invariant stays enforceable in one place.
 *
 * Ownership is guaranteed by the path itself: `users/{uid}/addresses/{id}`.
 * The transaction confirms the doc exists before writing the patch.
 */
export const updateAddress = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'updateAddress', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication required',
    );
  }

  const uid = context.auth.uid;

  try {
    const input = UpdateAddressSchema.parse(data);

    if (Object.keys(input.patch).length === 0) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'address/empty-patch',
      );
    }

    const db = admin.firestore();
    const addressRef = db.doc(addressPaths.address(uid, input.addressId));

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(addressRef);
      if (!snap.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'address/not-found',
          { addressId: input.addressId },
        );
      }

      const existing = snap.data() ?? {};
      const mergePayload: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
        ...input.patch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // If patch explicitly clears landmark (empty string), unset it.
      if (input.patch.landmark === '') {
        (mergePayload as Record<string, unknown>).landmark =
          admin.firestore.FieldValue.delete();
      }

      tx.update(addressRef, mergePayload);

      return {
        addressId: input.addressId,
        isDefault: existing.isDefault === true,
      };
    });

    logger.info('updateAddress success', {
      uid,
      addressId: result.addressId,
    });

    // S4: Audit log — records which keys changed but never the values
    // themselves (PII). `patchedKeys` lets ops investigate "who changed
    // this address" without exposing raw street numbers in audit_logs.
    try {
      await writeAuditLog({
        userId: uid,
        action: 'address.updated',
        entity: { type: 'address', id: result.addressId },
        metadata: {
          patchedKeys: Object.keys(input.patch).sort(),
          isDefault: result.isDefault,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (updateAddress)', auditError);
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
