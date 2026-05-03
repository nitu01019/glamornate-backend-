/**
 * Service Configuration Helpers
 *
 * Provides functions to detect which external services are configured.
 * Services activate automatically when credentials are provided - no code changes needed.
 */

import { createLogger } from './logger';

const logger = createLogger('service-config');

// ============================================================================
// Service Configuration Detection
// ============================================================================

// Stripe helpers (isStripeConfigured, isStripeWebhookConfigured) removed
// (Phase 1 — Stripe removal, 2026-05-02). Pay-at-spa only.

/**
 * Check if SendGrid is configured with API key + from-email.
 */
export function isSendGridConfigured(): boolean {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
}

// Twilio: removed M-TWILIO-REMOVE 2026-04-25 — phone OTP via Firebase Auth, push via FCM.

// ============================================================================
// Service Status
// ============================================================================

export interface ServiceStatus {
  email: boolean;
}

/**
 * Get the configuration status of all external services
 */
export function getServiceStatus(): ServiceStatus {
  return {
    email: isSendGridConfigured(),
  };
}

/**
 * Log the current service configuration status
 * Useful for debugging and startup diagnostics
 */
export function logServiceStatus(): void {
  const status = getServiceStatus();

  logger.info('External service configuration status', {
    email: status.email ? 'CONFIGURED' : 'NOT_CONFIGURED (no-op mode)',
  });

  if (!status.email) {
    logger.warn('SendGrid not configured - transactional emails disabled');
  }
}

// ============================================================================
// Demo Mode Helpers
// ============================================================================

// generateDemoPaymentIntentId + generateDemoRefundId removed (Phase 1 — Stripe
// removal, 2026-05-02). Pay-at-spa only.

/**
 * Generate a demo transaction ID
 */
export function generateDemoTransactionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `demo_txn_${timestamp}_${random}`;
}

// ============================================================================
// Environment helpers
// ============================================================================

/**
 * Check if running in production environment
 */
export function isProduction(): boolean {
  return process.env.FUNCTIONS_EMULATOR !== 'true' &&
    process.env.NODE_ENV === 'production';
}

/**
 * Check if running in emulator
 */
export function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

/**
 * Get environment name
 */
export function getEnvironment(): 'production' | 'staging' | 'development' | 'emulator' {
  if (isEmulator()) return 'emulator';
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'staging') return 'staging';
  return 'development';
}
