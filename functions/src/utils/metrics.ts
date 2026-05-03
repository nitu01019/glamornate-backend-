/**
 * TBS-05: Structured metrics helper for Cloud Logging → Log-based metrics.
 *
 * Emits a single INFO log entry per metric with `logging.googleapis.com/labels`,
 * which Google Cloud Monitoring can pick up as a log-based metric.
 *
 * PII-safe by default: any label value that looks like an email (contains `@`)
 * or phone number (>=10 consecutive digits) is dropped before emission.
 */

import { createLogger } from './logger';

const metricsLogger = createLogger('metrics');

const EMAIL_RE = /@/;
const PHONE_RE = /\b\d{10,}\b/;

export type MetricLabels = Record<string, string | number | boolean>;

/**
 * Drop labels whose stringified value looks like an email or phone number.
 * Returns a new object — never mutates the caller's input (immutable).
 */
function sanitizeLabels(labels?: MetricLabels): Record<string, string> {
  if (!labels) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const str = String(v);
    if (EMAIL_RE.test(str) || PHONE_RE.test(str)) continue;
    out[k] = str;
  }
  return out;
}

/**
 * Emit a single metric point. Cloud Logging will surface the `labels` map
 * under `logging.googleapis.com/labels` so it can drive log-based metrics.
 */
export function metric(
  name: string,
  value: number,
  labels?: MetricLabels,
): void {
  const sanitized = sanitizeLabels(labels);
  metricsLogger.info(`metric:${name}`, {
    metric: name,
    value,
    'logging.googleapis.com/labels': sanitized,
  });
}

/**
 * Named metric constants for the booking flow. Kept as a single `as const`
 * object so call-sites import `METRIC_BOOKING.DRAFT_LATENCY_MS` and get
 * string-literal typing for free.
 */
export const METRIC_BOOKING = {
  DRAFT_LATENCY_MS: 'booking.draft.latencyMs',
  CONFIRM_LATENCY_MS: 'booking.confirm.latencyMs',
  CANCEL_LATENCY_MS: 'booking.cancel.latencyMs',
  OUTCOME: 'booking.outcome',
} as const;

/**
 * Phase 10 (Booking Flow Fix v3.1, 2026-05-02): typed booking metric
 * names. The plain `metric()` API above is open-ended; this wrapper
 * narrows the namespace so a typo at the call site fails type-check
 * rather than silently emitting an unrecognised metric.
 */
export type BookingMetricName =
  | 'booking_created'
  | 'booking_cancelled'
  | 'booking_rescheduled'
  | 'overlap_check_ok'
  | 'overlap_check_skipped'
  | 'duplicate_booking'
  | 'slot_in_past'
  | 'phone_mismatch'
  | 'service_not_offered_by_spa'
  | 'voucher_applied';

/**
 * Emit a booking-flow metric with cardinality-clamped labels. spaId is
 * automatically piped through `bucket()` so the dashboard never blows past
 * the 100 000 time-series cap.
 */
export function recordBookingMetric(
  name: BookingMetricName,
  labels: MetricLabels & { spaId?: string } = {},
): void {
  const { spaId, ...rest } = labels;
  metric(`booking.${name}`, 1, {
    ...rest,
    ...(spaId !== undefined ? { spaIdBucket: bucket(spaId) } : {}),
  });
}

/**
 * Wrap an async operation and emit `${name}.latencyMs` on completion (success
 * OR error). Always re-throws on error so caller flow is unchanged. Adds an
 * `outcome: 'ok' | 'error'` label for easy splitting in dashboards.
 */
export async function timeIt<T>(
  name: string,
  fn: () => Promise<T>,
  labels?: MetricLabels,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    metric(`${name}.latencyMs`, Date.now() - start, {
      ...(labels ?? {}),
      outcome: 'ok',
    });
    return result;
  } catch (err) {
    metric(`${name}.latencyMs`, Date.now() - start, {
      ...(labels ?? {}),
      outcome: 'error',
    });
    throw err;
  }
}

/**
 * ========================================================================
 * CARDINALITY BOUND HELPERS (A-14)
 * ------------------------------------------------------------------------
 * Google Cloud Monitoring caps each project at 100 000 active time-series.
 * A label with unbounded cardinality (e.g. spaId, itemCount) breaches that
 * cap silently — the first N spas populate dashboards, the rest vanish.
 *
 * These helpers clamp unbounded values into a fixed, small number of
 * buckets so every metric emitted has BOUNDED cardinality in ALL labels.
 * Every call-site that ships a spaId / numeric label into a metric MUST
 * pipe through one of these.
 * ========================================================================
 */

/**
 * TODO(P4-04): Replace with the top-100 spa id list sourced from
 *   `gcloud firestore query spas order by bookingCount desc limit 100`
 * once the Cloud Monitoring metric definitions land. Until then this is a
 * pass-through with the 'other' fallback reserved for a future allow-list.
 */
const TOP_SPA_IDS = new Set<string>([
  // Intentionally empty — every spaId currently short-circuits to 'other'
  // to guarantee the cardinality invariant before the top-100 list is seeded.
]);

/**
 * Clamp a spaId to either the top-100 allow-list or the sentinel 'other'.
 * Returns a new string — never mutates the input.
 */
export function bucket(spaId: string | null | undefined): string {
  if (!spaId || typeof spaId !== 'string') return 'unknown';
  if (TOP_SPA_IDS.has(spaId)) return spaId;
  return 'other';
}

/**
 * Clamp a fraction (0..1) into quarters for refund-percentage style metrics.
 * Buckets: '0', '25', '50', '75', '100'.
 */
export function bucket5(fraction: number): string {
  if (typeof fraction !== 'number' || Number.isNaN(fraction)) return '0';
  if (fraction >= 1) return '100';
  if (fraction <= 0) return '0';
  if (fraction >= 0.75) return '75';
  if (fraction >= 0.5) return '50';
  if (fraction >= 0.25) return '25';
  return '0';
}

/**
 * Clamp a non-negative count into one of four log-scale buckets.
 * Buckets: '0-10', '11-100', '101-1k', '1k+'.
 */
export function bucket_log10(n: number): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return '0-10';
  if (n <= 10) return '0-10';
  if (n <= 100) return '11-100';
  if (n <= 1000) return '101-1k';
  return '1k+';
}

/**
 * Stringify a boolean for metric labels. Cloud Logging stores all label
 * values as strings; canonicalise here so dashboards don't split the same
 * signal into two distinct series.
 */
export function booleanToString(b: boolean): string {
  return b ? 'true' : 'false';
}
