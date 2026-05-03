/**
 * Notifications Outbox — durable, at-least-once dispatch helper (B7).
 *
 * PROBLEM this fixes:
 *   Before B7, `utils/notifications.ts` sent straight to FCM / SendGrid /
 *   Twilio inside the request path. A transient provider outage meant the
 *   notification was lost forever — the callable had already returned 200
 *   to the client and the message never retried.
 *
 * PATTERN:
 *   Writes of record (bookings, status changes, broadcasts) enqueue an
 *   outbox row instead of dispatching inline. A scheduled worker polls
 *   `notifications_outbox` for `status == 'pending' AND nextAttemptAt <= now`,
 *   dispatches each channel, and either marks the row delivered or schedules
 *   an exponential-backoff retry. After `maxRetries` attempts the row is
 *   marked `dead-letter` for operator review.
 *
 * INVARIANTS:
 *   - A row is never "lost": either status becomes 'delivered' or
 *     'dead-letter'. Transient failures never leave it in 'pending' without
 *     a future `nextAttemptAt`.
 *   - The schema is additive — adding a new channel is a non-breaking
 *     change because `channels` is an array of literals the worker
 *     switches on.
 *
 * PHASE 4 scope: this helper + worker are *infrastructure only*. Callers
 * in `utils/notifications.ts` still dispatch inline. Phase 5 migrates call
 * sites to `enqueueNotification`.
 */

import * as admin from 'firebase-admin';

export const OUTBOX_COLLECTION = 'notifications_outbox' as const;
export const OUTBOX_DEFAULT_MAX_RETRIES = 5 as const;

/**
 * Categorisation used by the worker and by observability dashboards.
 *
 * The worker itself only uses `type` for structured logging, so any string
 * is accepted at runtime. The listed literals are the canonical values used
 * by the main lifecycle flows; callers for ad-hoc or legacy types (e.g.
 * `booking_confirmed`, `en_route`, `refund_processed`) pass through without
 * a compile-time error because the string branch of the union absorbs them.
 */
export type NotificationType =
  | 'booking-confirmed'
  | 'booking-cancelled'
  | 'broadcast'
  | 'reminder'
  | 'other'
  | (string & {});

/** Transport channels the worker knows how to dispatch against. */
export type NotificationChannel = 'fcm' | 'email' | 'sms';

export type OutboxStatus = 'pending' | 'delivered' | 'dead-letter';

export interface OutboxPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface OutboxEntry {
  userId: string;
  type: NotificationType;
  channels: NotificationChannel[];
  payload: OutboxPayload;
  status: OutboxStatus;
  retries: number;
  maxRetries: number;
  nextAttemptAt: admin.firestore.Timestamp;
  createdAt: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
  lastError?: string;
}

export type EnqueueInput = Pick<
  OutboxEntry,
  'userId' | 'type' | 'channels' | 'payload'
> & {
  /** Override default `OUTBOX_DEFAULT_MAX_RETRIES`. */
  maxRetries?: number;
  /** Delay the first attempt. Defaults to `now` (attempt immediately). */
  notBefore?: admin.firestore.Timestamp | Date;
};

/**
 * Enqueue a single notification for the scheduled worker to dispatch.
 *
 * Returns the Firestore document id so the caller can attach it to audit
 * logs or return it for idempotency tests. No network dispatch happens
 * inside this call — the worker picks it up within `nextAttemptAt`
 * (default: immediately).
 */
export async function enqueueNotification(
  input: EnqueueInput,
  db: FirebaseFirestore.Firestore = admin.firestore(),
): Promise<string> {
  if (!input.channels || input.channels.length === 0) {
    throw new Error('enqueueNotification: at least one channel required');
  }

  const now = admin.firestore.Timestamp.now();
  const nextAttemptAt = normaliseTimestamp(input.notBefore ?? now);

  const ref = db.collection(OUTBOX_COLLECTION).doc();
  const row: OutboxEntry = {
    userId: input.userId,
    type: input.type,
    channels: [...input.channels],
    payload: {
      title: input.payload.title,
      body: input.payload.body,
      data: input.payload.data ?? {},
    },
    status: 'pending',
    retries: 0,
    maxRetries: input.maxRetries ?? OUTBOX_DEFAULT_MAX_RETRIES,
    nextAttemptAt,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(row);
  return ref.id;
}

/**
 * Adapter input for migrating legacy callers that still shape their
 * notification payload as `{ push: {...}, email: {...}, sms: {...} }` with
 * a boolean-map `channels`.
 *
 * The adapter is intentionally permissive about optional fields so call
 * sites (which previously pushed straight to SendGrid / Twilio) can migrate
 * without restructuring their data flow.
 */
export interface LegacyNotificationContext {
  userId: string;
  type: string;
  channels: { push?: boolean; email?: boolean; sms?: boolean };
  push: {
    title: string;
    body: string;
    imageUrl?: string;
    data?: Record<string, string>;
  };
  email?: {
    to?: string;
    subject?: string;
    templateId?: string;
    templateData?: Record<string, unknown>;
    html?: string;
  };
  sms?: {
    to?: string;
    body?: string;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Convenience adapter: translate a legacy multi-channel notification
 * context into an outbox enqueue.
 *
 * - `channels.push` maps to `'fcm'` (FCM is our only push transport).
 * - `channels.email` / `channels.sms` are dropped silently if no recipient
 *   address was provided, because the worker's email/SMS dispatchers would
 *   no-op anyway and we want to avoid dead-letter noise.
 * - The payload is taken from the `push` field, since that is the only
 *   place with a title+body pair. Email/SMS-specific metadata
 *   (`templateId`, `templateData`, `html`, `to`, custom body) is folded
 *   into `payload.data` so the worker can reconstitute a provider call.
 *
 * Returns the enqueued outbox doc id, or `null` if no active channel has
 * a viable recipient (nothing to do).
 */
export async function enqueueNotificationFromContext(
  context: LegacyNotificationContext,
  db: FirebaseFirestore.Firestore = admin.firestore(),
): Promise<string | null> {
  const channels: NotificationChannel[] = [];
  if (context.channels.push) channels.push('fcm');
  if (context.channels.email && context.email?.to) channels.push('email');
  if (context.channels.sms && context.sms?.to) channels.push('sms');

  if (channels.length === 0) {
    return null;
  }

  const data: Record<string, string> = { ...(context.push.data ?? {}) };
  if (context.email?.templateId) data.emailTemplateId = context.email.templateId;
  if (context.email?.to) data.emailTo = context.email.to;
  if (context.email?.subject) data.emailSubject = context.email.subject;
  if (context.email?.templateData && Object.keys(context.email.templateData).length > 0) {
    // Firestore `payload.data` must be Record<string, string>; serialise to JSON.
    data.emailTemplateData = JSON.stringify(
      sanitiseTemplateData(context.email.templateData),
    );
  }
  if (context.sms?.to) data.smsTo = context.sms.to;
  if (context.sms?.body) data.smsBody = context.sms.body;
  if (context.metadata) {
    for (const [k, v] of Object.entries(context.metadata)) {
      if (v !== undefined && v !== null) {
        data[`meta_${k}`] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
  }

  return enqueueNotification(
    {
      userId: context.userId,
      type: context.type,
      channels,
      payload: {
        title: context.push.title,
        body: context.push.body,
        data,
      },
    },
    db,
  );
}

/**
 * Strip values that Firestore rejects (undefined, functions, class instances)
 * before serialising templateData to JSON. Keeps primitives, arrays, and
 * plain objects; replaces anything else with its string representation.
 */
function sanitiseTemplateData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      result[k] = v;
    } else if (Array.isArray(v)) {
      result[k] = v;
    } else if (typeof v === 'object') {
      result[k] = v;
    } else {
      result[k] = String(v);
    }
  }
  return result;
}

/**
 * Compute the next exponential-backoff delay (milliseconds) for a failed
 * attempt. Capped at 60s so a hot retry loop still recovers quickly once
 * the provider comes back.
 */
export function computeBackoffMs(attempt: number): number {
  const base = Math.pow(2, Math.max(1, attempt)) * 1000;
  return Math.min(60_000, base);
}

/** Internal: coerce Date/Timestamp into a Firestore Timestamp. */
function normaliseTimestamp(
  value: admin.firestore.Timestamp | Date,
): admin.firestore.Timestamp {
  if (value instanceof Date) {
    return admin.firestore.Timestamp.fromDate(value);
  }
  return value;
}
