/**
 * Shared zod input schemas for Firebase callables (BE-M2).
 *
 * These schemas are imported by the backend callables AND by any client
 * code that needs to pre-validate a payload before invoking the callable
 * (e.g. to surface a form error without burning a round trip). Keeping
 * them in `@glamornate/contracts` guarantees the wire format stays in
 * lockstep between the two ends.
 *
 * Scope of Phase 4 extraction: simple, truly-shareable schemas with no
 * handler-specific branching. Complex handler-internal schemas stay
 * inline in the callable — adding them here would leak server concerns
 * into the shared package. Phase 5 will evaluate each remaining inline
 * schema on a case-by-case basis.
 */

import { z } from 'zod';

/**
 * `markReviewHelpful` — idempotent upvote of a review.
 * Used by `backend/functions/src/callable/markReviewHelpful.ts`.
 */
export const MarkReviewHelpfulInputSchema = z.object({
  reviewId: z.string().min(1),
});
export type MarkReviewHelpfulInput = z.infer<typeof MarkReviewHelpfulInputSchema>;

/**
 * `reportReview` — one-shot report of an inappropriate review.
 * Used by `backend/functions/src/callable/reportReview.ts`.
 */
export const ReportReviewInputSchema = z.object({
  reviewId: z.string().min(1),
});
export type ReportReviewInput = z.infer<typeof ReportReviewInputSchema>;

/**
 * `validateVoucher` — dry-run a voucher against a pending booking.
 * Used by `backend/functions/src/callable/validateVoucher.ts`.
 *
 * Returns discount pricing but does NOT consume the voucher.
 */
export const ValidateVoucherInputSchema = z.object({
  code: z.string().min(1),
  bookingData: z.object({
    spaId: z.string().min(1),
    serviceIds: z.array(z.string().min(1)),
    totalAmount: z.number().nonnegative(),
  }),
});
export type ValidateVoucherInput = z.infer<typeof ValidateVoucherInputSchema>;
