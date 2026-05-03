import * as functions from 'firebase-functions';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { validateVoucher as validateVoucherUtil } from '../utils/vouchers';
import { handleError } from '../utils/error-handler';
import { writeAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';
import {
  ValidateVoucherInputSchema as ValidateVoucherSchema,
  type ValidateVoucherInput,
} from '../lib/contracts';

const logger = createLogger('validateVoucher');

/**
 * Validate a voucher code for a booking
 */
export const validateVoucher = callableOpts({ maxInstances: 50 }).https.onCall(
  withRateLimit(
    { name: 'validateVoucher', windowMs: 60_000, max: 30 },
    async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required');
  }

  const userId = context.auth.uid;

  try {
    const validated: ValidateVoucherInput = ValidateVoucherSchema.parse(data);

    const result = await validateVoucherUtil(
      validated.code,
      userId,
      validated.bookingData
    );

    // S4: Audit log — non-stateful read, but useful to detect brute-force
    // voucher code guessing. Records the attempt + result.valid flag only;
    // no before/after transition because nothing mutates.
    try {
      await writeAuditLog({
        userId,
        action: 'voucher.validated',
        entity: { type: 'voucher', id: validated.code },
        metadata: {
          valid: result.valid,
          discountAmount: result.discountAmount,
          spaId: validated.bookingData.spaId,
          serviceCount: validated.bookingData.serviceIds.length,
        },
      });
    } catch (auditError) {
      logger.warn('writeAuditLog failed (validateVoucher)', auditError);
    }

    return {
      success: true,
      ...result,
    };

  } catch (error) {
    throw handleError(error);
  }
    },
  ),
);
