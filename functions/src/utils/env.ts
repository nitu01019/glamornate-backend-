import { z } from 'zod';

const envSchema = z.object({
  // Stripe env vars removed (Phase 1 — Stripe removal, 2026-05-02). Pay-at-spa only.
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().email().optional(),
  SENDGRID_FROM_NAME: z.string().optional(),
  // Twilio: removed M-TWILIO-REMOVE 2026-04-25 — phone OTP via Firebase Auth, push via FCM.
  ALGOLIA_APP_ID: z.string().optional(),
  ALGOLIA_ADMIN_KEY: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // GCP / Firebase project identifiers
  GCP_PROJECT_ID: z.string().optional(),
  GCLOUD_PROJECT: z.string().optional(),

  // Financial configuration
  TAX_RATE_PERCENT: z.string().optional(),
  PLATFORM_FEE_PERCENT: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export function validateRequiredEnv(keys: string[]): void {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
