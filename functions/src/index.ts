import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';
import httpApp from './http/app';

// Initialize Firebase Admin
admin.initializeApp();

// ========== HTTP API (Express-wrapped v2 onRequest) ==========
export const api = onRequest(
  {
    region: 'asia-south1',
    memory: '512MiB',
    timeoutSeconds: 60,
    minInstances: 1,
    cors: false, // Express handles CORS explicitly via allowlist.
    invoker: 'public',
  },
  httpApp,
);

// NOTE (Phase 9, 2026-04-25): Removed obsolete `validateRequiredEnv` call that
// asserted `SENDGRID_TEMPLATE_*` keys. Those template IDs were retired when
// the SendGrid email-template path was removed from `utils/env.ts` and
// `.env.example`. The previous block was wrapped in try/catch but spammed
// startup logs with `[env] Startup validation warning:` on every cold start.
// Optional env vars are now declared in `utils/env.ts` and validated lazily
// at the call site that needs them.

// ========== Callable Functions ==========
// Phase 1 (Stripe removal, 2026-05-02): file renamed createBookingDraft → createBooking.
// `createBookingDraft` is exported as a backward-compat alias for pinned APK clients
// that still call the old name; remove on 2026-05-16 with the Stripe-webhook stub.
export { createBooking, createBookingDraft } from './callable/createBooking';
// confirmBooking removed (Phase 1 — Stripe removal). Stripe-driven payment-confirmation
// callable is gone; createBooking now writes directly to 'confirmed' for pay-at-spa.
export { cancelBooking } from './callable/cancelBooking';
export { rescheduleBooking } from './callable/rescheduleBooking';
export { checkInCustomer } from './callable/checkInCustomer';
export { checkOutService } from './callable/checkOutService';
export { submitReview } from './callable/submitReview';
export { submitSpaRegistration } from './callable/submitSpaRegistration';
export { approveSpaRegistration } from './callable/approveSpaRegistration';
export { redeemVoucher } from './callable/redeemVoucher';
export { getBookingRealtimeStatus } from './callable/getBookingRealtimeStatus';
// createPaymentIntent removed (Phase 1 — Stripe removal). Pay-at-spa only — no online checkout.
export { validateVoucher } from './callable/validateVoucher';
export { getAvailableSlots } from './callable/getAvailableSlots';
export { checkSlotAvailability } from './callable/checkSlotAvailability';
export { getAvailabilityCalendar } from './callable/getAvailabilityCalendar';
export { getNextAvailableSlot } from './callable/getNextAvailableSlot';
export { getTherapistAvailability } from './callable/getTherapistAvailability';
export { getAvailableDates } from './callable/getAvailableDates';
export { markAllNotificationsRead } from './callable/markAllNotificationsRead';
export { markReviewHelpful } from './callable/markReviewHelpful';
export { reportReview } from './callable/reportReview';
export { deleteAccount } from './auth/delete-account';
export { revokeMySessions } from './auth/revoke-sessions';
// Phase 4 (Booking Flow Fix v3.1, 2026-05-02): admin-only merge of two
// user uids when the customer pre-created data under both before linking.
export { mergeUserAccounts } from './auth/merge-accounts';
// Phase 9B (Booking Flow Fix v3.1, 2026-05-02): customer-facing voucher
// application. Replaces the prior client-side voucherCode write that
// allowed privilege escalation.
export { applyVoucher } from './callable/applyVoucher';

// ========== Phase 7 — Signup availability check ==========
export { checkSignupAvailability } from './auth/check-signup';

// ========== Phase 4 / 4A — Address Subcollection Callables ==========
export { addAddress } from './callable/addAddress';
export { updateAddress } from './callable/updateAddress';
export { deleteAddress } from './callable/deleteAddress';
export { setDefaultAddress } from './callable/setDefaultAddress';
export { migrateAddressesToSubcollection } from './callable/migrateAddressesToSubcollection';

// ========== Phase 4 / 4B — Location Service Callables ==========
export { reverseGeocode } from './callable/reverseGeocode';

// ========== Phase 4 / 4C — Notifications Broadcast Callables ==========
export { dispatchBroadcast } from './callable/dispatchBroadcast';

// ========== Event-Triggered Functions ==========
export { onBookingCreated } from './events/onBookingCreated';
// onBookingConfirmed removed: all confirmed-status logic is now handled by
// onBookingStatusChanged to prevent duplicate trigger firing and double notifications.
// onBookingCancelled removed: cancellation side-effects (notifications, slot
// release) are handled exclusively by onBookingStatusChanged to prevent
// duplicate notifications and race conditions.
export { onUserCreated } from './events/onUserCreated';
export { onReviewCreated } from './events/onReviewCreated';
export { onBookingStatusChanged } from './events/onBookingStatusChanged';

// ========== Triggered Functions ==========
// processRefund removed (Phase 1 — Stripe removal). No online payments → no refunds.
// scheduleReminders: schedules Cloud Tasks reminders when booking is confirmed
export { scheduleReminders } from './triggered/scheduleReminders';

// NOTE: The following triggered functions are NOT exported because they duplicate
// functionality already handled by the event handlers in events/:
//   - sendBookingConfirmations  → duplicated by onBookingCreated
//   - sendStatusUpdate          → duplicated by onBookingStatusChanged
//   - sendWelcomeEmail          → overlaps onUserCreated (duplicate wallet/audit/notification);
//                                  unique SendGrid email template should be merged into onUserCreated
//   - updateTherapistRating     → duplicated by onReviewCreated

// ========== Scheduled Functions ==========
export { recalculateAvailability } from './scheduled/recalculateAvailability';
// cleanupExpiredDrafts removed (Phase 1 — Stripe removal). Draft state collapsed away;
// pay-at-spa bookings write directly to 'confirmed' so there are no expiring drafts.
export { processPayouts } from './scheduled/processPayouts';
export { sendDailyReminders } from './scheduled/sendDailyReminders';
export { aggregateAnalytics } from './scheduled/aggregateAnalytics';
export { cleanupOldNotifications } from './scheduled/cleanupOldNotifications';
export { autoProcessBookings } from './scheduled/autoProcessBookings';
// B7: Notifications outbox worker (infrastructure only in Phase 4).
// See docs/remediation/BLOCKERS.md#BLOCKER-6 for the deploy-time note that
// Phase 5 must migrate notifications.ts callers before this becomes
// load-bearing.
export { processNotificationsOutbox } from './scheduled/processNotificationsOutbox';
// Phase 7 — daily rebuild of the signup-availability bloom filters.
export { rebuildSignupBloomFilter } from './scheduled/rebuildSignupBloomFilter';
