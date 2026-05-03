// =============================================================================
// Phase 4 / 4A — Consumer contract (stable surface for Alpha's Phase 2)
// =============================================================================
//
//   addAddress({ label, name, phone, flatHouse, street, landmark?, city,
//                state, pincode, isDefault?, geo? })
//     → { addressId: string, isDefault: boolean }
//
//   updateAddress({ addressId, patch: Partial<AddressInput (without isDefault)> })
//     → { addressId: string, isDefault: boolean }
//
//   deleteAddress({ addressId })
//     → { deleted: true, promotedDefault?: string }
//
//   setDefaultAddress({ addressId })
//     → { addressId: string }
//
//   migrateAddressesToSubcollection()
//     → { migrated: number, alreadyDone: boolean }
//
// All callables:
//   - require auth (context.auth.uid)
//   - validate via Zod; errors surface as HttpsError('invalid-argument', ...)
//   - are transactional: the "exactly one default per user" invariant holds
//     for every sequence of concurrent add/update/delete operations.
//
// The callable name in Firebase is the file name (addAddress), matching the
// existing pattern in this codebase.
// =============================================================================

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import {
  AddressInputSchema,
  MAX_ADDRESSES_PER_USER,
  addressPaths,
  writeUserAddressSummary,
  newAddressId,
} from '../utils/addresses';
import { writeAuditLog } from '../utils/audit-log';

const logger = createLogger('addAddress');

/**
 * `addAddress` — append a new address to the authenticated user's
 * subcollection at `users/{uid}/addresses/{addressId}`.
 *
 * Transactional invariants:
 *   - If this is the user's first address, it becomes default
 *     regardless of the client-supplied `isDefault` flag.
 *   - If `isDefault: true`, every other address is demoted in the same
 *     transaction so exactly one default survives.
 *   - The user document is updated in the same transaction to keep
 *     `defaultAddressId` and `addressCount` in sync.
 */
export const addAddress = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'addAddress', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication required',
    );
  }

  const uid = context.auth.uid;

  try {
    const input = AddressInputSchema.parse(data);

    const db = admin.firestore();
    const addressId = newAddressId(db, uid);
    const addressRef = db.doc(addressPaths.address(uid, addressId));

    const result = await db.runTransaction(async (tx) => {
      const subcolRef = db.collection(addressPaths.subcollection(uid));
      const existingSnap = await tx.get(subcolRef);

      if (existingSnap.size >= MAX_ADDRESSES_PER_USER) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `address/limit-reached`,
          { max: MAX_ADDRESSES_PER_USER },
        );
      }

      // First-address rule: always default regardless of client flag.
      const isFirst = existingSnap.empty;
      const wantsDefault = isFirst || input.isDefault === true;

      // Build the persisted document.
      const now = admin.firestore.FieldValue.serverTimestamp();
      const payload: Record<string, unknown> = {
        id: addressId,
        label: input.label,
        name: input.name,
        phone: input.phone,
        flatHouse: input.flatHouse,
        street: input.street,
        city: input.city,
        state: input.state,
        pincode: input.pincode,
        isDefault: wantsDefault,
        createdAt: now,
        updatedAt: now,
      };
      if (typeof input.landmark === 'string' && input.landmark.length > 0) {
        payload.landmark = input.landmark;
      }
      if (input.geo) {
        payload.geo = input.geo;
      }

      tx.set(addressRef, payload);

      // Enforce the invariant.
      const newDefaultId = wantsDefault ? addressId : null;
      if (wantsDefault) {
        // Demote every existing doc's isDefault flag.
        for (const doc of existingSnap.docs) {
          if (doc.data().isDefault === true) {
            tx.update(doc.ref, {
              isDefault: false,
              updatedAt: now,
            });
          }
        }
      }

      // Compute the effective default after this op: the new one if we set
      // it, else whoever was default before (or null if none).
      const currentDefault =
        newDefaultId ??
        existingSnap.docs.find((d) => d.data().isDefault === true)?.id ??
        null;

      const nextCount = existingSnap.size + 1;
      writeUserAddressSummary(tx, db, uid, currentDefault, nextCount);

      return { addressId, isDefault: wantsDefault };
    });

    logger.info('addAddress success', {
      uid,
      addressId: result.addressId,
      isDefault: result.isDefault,
    });

    // S4: Audit log — addresses are PII. Log creation with only
    // non-sensitive metadata (label, default status). The actual street
    // / house number is never copied into audit_logs.
    try {
      await writeAuditLog({
        userId: uid,
        action: 'address.created',
        entity: { type: 'address', id: result.addressId },
        before: null,
        after: { isDefault: result.isDefault },
        metadata: {
          label: input.label,
          city: input.city,
          state: input.state,
          pincode: input.pincode,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (addAddress)', auditError);
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
