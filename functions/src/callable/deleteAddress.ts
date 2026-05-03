import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';
import {
  addressPaths,
  hasActiveBookingReferencingAddress,
  writeUserAddressSummary,
} from '../utils/addresses';
import { writeAuditLog } from '../utils/audit-log';

const logger = createLogger('deleteAddress');

const DeleteAddressSchema = z.object({
  addressId: z.string().trim().min(1).max(128),
});

/**
 * `deleteAddress` — remove a single address. Blocks deletion if an
 * active booking (draft through in_progress) references the address.
 *
 * If the deleted address was the default AND other addresses remain,
 * promote the most-recently-updated remaining address to default. If
 * the user had no other addresses, `defaultAddressId` is cleared.
 *
 * All writes happen in a single transaction so the invariant holds
 * even under concurrent calls.
 */
export const deleteAddress = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'deleteAddress', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Authentication required',
    );
  }

  const uid = context.auth.uid;

  try {
    const input = DeleteAddressSchema.parse(data);
    const db = admin.firestore();

    // Booking-reference check happens OUTSIDE the transaction because
    // Firestore transactions may not run collection queries that are
    // not part of the read-then-write window. A race (user books and
    // deletes simultaneously) is acceptable — the booking write path
    // re-validates the address.
    const blocked = await hasActiveBookingReferencingAddress(
      db,
      uid,
      input.addressId,
    );
    if (blocked) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'address/has-active-booking',
        { addressId: input.addressId },
      );
    }

    const addressRef = db.doc(addressPaths.address(uid, input.addressId));

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

      const wasDefault = target.data().isDefault === true;

      // Delete first (within the tx).
      tx.delete(addressRef);

      // Choose a replacement default, if needed, from the remaining set.
      const remaining = allSnap.docs.filter((d) => d.id !== input.addressId);
      let promotedDefault: string | null = null;

      if (remaining.length === 0) {
        writeUserAddressSummary(tx, db, uid, null, 0);
        return { deleted: true as const, promotedDefault: null };
      }

      if (wasDefault) {
        // Pick most-recently-updated doc among survivors.
        const sorted = [...remaining].sort((a, b) => {
          const ad = a.data() as Record<string, unknown>;
          const bd = b.data() as Record<string, unknown>;
          const atime = readMillis(ad.updatedAt) ?? readMillis(ad.createdAt) ?? 0;
          const btime = readMillis(bd.updatedAt) ?? readMillis(bd.createdAt) ?? 0;
          if (atime !== btime) return btime - atime;
          return a.id > b.id ? -1 : 1;
        });
        const promoted = sorted[0];
        promotedDefault = promoted.id;

        tx.update(promoted.ref, {
          isDefault: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      const effectiveDefault =
        promotedDefault ??
        remaining.find((d) => d.data().isDefault === true)?.id ??
        null;

      writeUserAddressSummary(tx, db, uid, effectiveDefault, remaining.length);

      return {
        deleted: true as const,
        promotedDefault,
      };
    });

    logger.info('deleteAddress success', {
      uid,
      addressId: input.addressId,
      promotedDefault: result.promotedDefault,
    });

    // S4: Audit log — deletions are GDPR-relevant. Records only the
    // address id + whether a new default was promoted; the address
    // body itself is gone, so we only keep a pointer for auditors.
    try {
      await writeAuditLog({
        userId: uid,
        action: 'address.deleted',
        entity: { type: 'address', id: input.addressId },
        metadata: {
          promotedDefault: result.promotedDefault ?? null,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (deleteAddress)', auditError);
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

function readMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as { toMillis?: () => number; seconds?: number };
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return null;
}
