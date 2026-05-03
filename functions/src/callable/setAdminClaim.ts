/**
 * setAdminClaim
 *
 * Admin-only callable that idempotently mirrors the Firestore
 * `users/{uid}.role === 'admin'` state into a Firebase Auth custom claim
 * (`{ admin: true }`). Used to migrate the storage.rules / firestore.rules
 * authorization layer from Firestore-doc role lookups to verified custom
 * claims (defense-in-depth: tighter blast radius if rules ever regress).
 *
 * Usage (operator, via Firebase callable client):
 *   await callable('setAdminClaim')({ targetUid: '<admin-uid>' })
 *
 * Idempotent: re-running for the same uid produces the same end state.
 *
 * Security:
 *   - Caller must be authenticated AND have role === 'admin' in
 *     Firestore users/{caller-uid}.
 *   - App Check enforced via `callableOpts()` defaults.
 *   - Rate-limited via `withRateLimit` (10 req/min/uid).
 *
 * Response:
 *   { success: true, uid: string, claimsSet: { admin: true }, before: { role } }
 *
 * See `docs/runbooks/admin-claims-migration.md` for the operator runbook.
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { handleError } from '../utils/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger('setAdminClaim');

const SetAdminClaimSchema = z.object({
  targetUid: z.string().min(1).max(128),
});

export type SetAdminClaimInput = z.infer<typeof SetAdminClaimSchema>;

export interface SetAdminClaimResult {
  success: true;
  uid: string;
  claimsSet: { admin: true };
  before: { role: string | null };
}

export const setAdminClaim = callableOpts({ maxInstances: 5 }).https.onCall(
  withRateLimit<unknown, SetAdminClaimResult>(
    { name: 'setAdminClaim', windowMs: 60_000, max: 10 },
    async (data, context): Promise<SetAdminClaimResult> => {
      if (!context.auth) {
        throw new functions.https.HttpsError(
          'unauthenticated',
          'Authentication required.',
        );
      }

      const callerUid = context.auth.uid;

      try {
        // -----------------------------------------------------------------
        // 1. Verify caller is an admin (Firestore users/{caller-uid}.role)
        //    We deliberately gate on the Firestore document — not the
        //    custom claim — because this callable is the bootstrap that
        //    sets the very first claim. A claim-only gate would create a
        //    chicken-and-egg problem during the migration.
        // -----------------------------------------------------------------
        const db = admin.firestore();
        const callerSnap = await db.collection('users').doc(callerUid).get();
        const callerData = callerSnap.exists ? callerSnap.data() : undefined;

        if (!callerData || callerData.role !== 'admin') {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only existing admins may set the admin claim.',
          );
        }

        // -----------------------------------------------------------------
        // 2. Validate payload
        // -----------------------------------------------------------------
        const validated: SetAdminClaimInput = SetAdminClaimSchema.parse(data);
        const { targetUid } = validated;

        // -----------------------------------------------------------------
        // 3. Verify the target's Firestore role is also 'admin'
        //    Refusing to set the claim for a non-admin Firestore user keeps
        //    the two sources of truth (Firestore role + custom claim)
        //    aligned and prevents accidental privilege-broadening.
        // -----------------------------------------------------------------
        const targetSnap = await db.collection('users').doc(targetUid).get();
        const beforeRole = targetSnap.exists
          ? (targetSnap.data()?.role as string | undefined) ?? null
          : null;

        if (beforeRole !== 'admin') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `Target uid ${targetUid} does not have role='admin' in Firestore. Refusing to set admin claim.`,
          );
        }

        // -----------------------------------------------------------------
        // 4. Look up the existing Auth user and merge the claim
        //    `setCustomUserClaims` is a full overwrite — we read the
        //    existing claims first and merge `{ admin: true }` on top so
        //    other claims (if any) are preserved. The operation is
        //    idempotent: a second call with the same target produces the
        //    same end state.
        // -----------------------------------------------------------------
        let existingUser: admin.auth.UserRecord | null = null;
        try {
          existingUser = await admin.auth().getUser(targetUid);
        } catch (err) {
          // `auth/user-not-found` is the only expected failure here; surface
          // anything else as `internal` via handleError below.
          if (
            (err as { code?: string }).code === 'auth/user-not-found'
          ) {
            throw new functions.https.HttpsError(
              'not-found',
              `Auth user ${targetUid} not found.`,
            );
          }
          throw err;
        }

        const mergedClaims = {
          ...(existingUser?.customClaims ?? {}),
          admin: true,
        } as { admin: true } & Record<string, unknown>;

        await admin.auth().setCustomUserClaims(targetUid, mergedClaims);

        logger.info('Admin claim set', {
          callerUid,
          targetUid,
          beforeRole,
        });

        return {
          success: true,
          uid: targetUid,
          claimsSet: { admin: true },
          before: { role: beforeRole },
        };
      } catch (err) {
        // Re-throw HttpsErrors as-is; map everything else through handleError.
        if (err instanceof functions.https.HttpsError) {
          throw err;
        }
        logger.error('setAdminClaim failed', { callerUid, error: err });
        throw handleError(err);
      }
    },
  ),
);
