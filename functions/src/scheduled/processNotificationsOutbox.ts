/**
 * `processNotificationsOutbox` — drains the notification outbox (B7).
 *
 * Runs every 1 minute via Cloud Scheduler / Pub/Sub. Reads up to 50
 * pending rows whose `nextAttemptAt <= now`, dispatches each channel in
 * parallel, and updates the row to `delivered` or schedules an
 * exponential-backoff retry. After `maxRetries` attempts the row is
 * flipped to `dead-letter` for operator triage.
 *
 * SCHEDULER NOTE (M-SCHEDULER-FIX): Cloud Scheduler's minimum supported
 * granularity is **1 minute**. The original `'every 30 seconds'` string
 * is invalid App Engine syntax and caused deploy-time HTTP 400
 * "invalid schedule/timezone" when the Scheduler job was created.
 * If sub-minute draining is ever required, move to a long-running
 * worker or Cloud Tasks with a short delay. `timeZone` is pinned to
 * `Asia/Kolkata` (project home region) so cron maths are stable even
 * when the GCP default timezone flips.
 *
 * IMPORTANT (Phase 4 scope): `utils/notifications.ts` is NOT yet migrated
 * to enqueue via this outbox. Until that Phase 5 follow-up lands, this
 * worker will see an empty collection and do nothing — which is exactly
 * what we want: infrastructure in place without behaviour change.
 *
 * See docs/remediation/BLOCKERS.md#BLOCKER-6 for deploy/operational notes.
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { createLogger } from '../utils/logger';
import {
  OUTBOX_COLLECTION,
  OUTBOX_DEFAULT_MAX_RETRIES,
  OutboxEntry,
  computeBackoffMs,
} from '../utils/notifications-outbox';
import {
  sendPushNotification,
  sendEmailNotification,
  sendSmsNotification,
} from '../utils/notifications';

const logger = createLogger('processNotificationsOutbox');

/** Max rows drained per invocation. Bounds memory + keeps each run short. */
export const OUTBOX_BATCH_SIZE = 50;

export const processNotificationsOutbox = functions
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .pubsub.schedule('every 1 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    const snap = await db
      .collection(OUTBOX_COLLECTION)
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', now)
      .limit(OUTBOX_BATCH_SIZE)
      .get();

    if (snap.empty) {
      return null;
    }

    logger.info('Draining notifications outbox', { candidates: snap.size });

    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const doc of snap.docs) {
      const data = doc.data() as OutboxEntry;
      try {
        await dispatchChannels(data);
        await doc.ref.update({
          status: 'delivered',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastError: admin.firestore.FieldValue.delete(),
        });
        delivered += 1;
      } catch (error) {
        const retries = (data.retries ?? 0) + 1;
        const maxRetries = data.maxRetries ?? OUTBOX_DEFAULT_MAX_RETRIES;
        const message = error instanceof Error ? error.message : String(error);

        if (retries >= maxRetries) {
          await doc.ref.update({
            status: 'dead-letter',
            retries,
            lastError: message,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          dead += 1;
          logger.error('Outbox row moved to dead-letter', {
            id: doc.id,
            userId: data.userId,
            type: data.type,
            retries,
            error: message,
          });
        } else {
          const backoffMs = computeBackoffMs(retries);
          const nextAttemptAt = admin.firestore.Timestamp.fromMillis(
            Date.now() + backoffMs,
          );
          await doc.ref.update({
            retries,
            nextAttemptAt,
            lastError: message,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          retried += 1;
          logger.warn('Outbox row retry scheduled', {
            id: doc.id,
            userId: data.userId,
            retries,
            backoffMs,
            error: message,
          });
        }
      }
    }

    logger.info('Outbox drain complete', {
      scanned: snap.size,
      delivered,
      retried,
      dead,
    });

    return null;
  });

/**
 * Dispatch every channel listed on the entry.
 *
 * The underlying `sendPushNotification` / `sendEmailNotification` helpers
 * internally log + swallow provider errors and return `false` on failure.
 * To keep the retry semantics of the outbox intact, we re-throw whenever
 * *every* dispatched channel reported false — that way a provider outage
 * causes a retry, but a partial success (push ok, email fails) doesn't
 * get redelivered.
 *
 * Phase 5 will tighten this by teaching the helpers to bubble structured
 * errors instead of booleans; until then this adapter gives us the
 * desired retry behaviour without refactoring the whole notifications
 * module.
 */
async function dispatchChannels(entry: OutboxEntry): Promise<void> {
  const results: Array<{ channel: string; ok: boolean }> = [];

  if (entry.channels.includes('fcm')) {
    const ok = await sendPushNotification(entry.userId, {
      title: entry.payload.title,
      body: entry.payload.body,
      data: entry.payload.data,
    });
    results.push({ channel: 'fcm', ok });
  }

  if (entry.channels.includes('email')) {
    const ok = await resolveAndSendEmail(entry).catch((err) => {
      logger.warn('Email dispatch threw', {
        userId: entry.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    results.push({ channel: 'email', ok });
  }

  if (entry.channels.includes('sms')) {
    const smsTo = entry.payload.data?.smsTo;
    const smsBody = entry.payload.data?.smsBody;
    if (smsTo && smsBody) {
      const ok = await sendSmsNotification({ to: smsTo, body: smsBody }).catch((err) => {
        logger.warn('SMS dispatch threw', {
          userId: entry.userId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      });
      results.push({ channel: 'sms', ok });
    } else {
      logger.warn('SMS channel requested but smsTo/smsBody missing — skipping', {
        userId: entry.userId,
        type: entry.type,
      });
      // Do NOT push to results — avoids poisoning anySucceeded for a misconfigured row.
    }
  }

  const anySucceeded = results.some((r) => r.ok);
  if (!anySucceeded) {
    throw new Error(
      `All channels failed: ${results.map((r) => r.channel).join(',')}`,
    );
  }
}

/**
 * Pre-Phase-5 adapter: look up the user's email then delegate to
 * `sendEmailNotification`. Kept inline so the worker stays a single
 * file; extracted to a helper in Phase 5.
 *
 * Returns true if the provider reported success, false otherwise.
 */
async function resolveAndSendEmail(entry: OutboxEntry): Promise<boolean> {
  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(entry.userId).get();
  const email = userDoc.data()?.profile?.email ?? userDoc.data()?.email;
  if (!email) return false;

  const emailTemplateId = entry.payload.data?.emailTemplateId as string | undefined;

  let templateData: Record<string, unknown> | undefined;
  const rawTemplateData = entry.payload.data?.emailTemplateData as string | undefined;
  if (rawTemplateData) {
    try {
      templateData = JSON.parse(rawTemplateData) as Record<string, unknown>;
    } catch {
      logger.warn('emailTemplateData JSON parse failed — sending without merge fields', {
        userId: entry.userId,
      });
    }
  }

  return sendEmailNotification({
    to: email,
    subject: (entry.payload.data?.emailSubject as string | undefined) ?? entry.payload.title,
    templateId: emailTemplateId,
    templateData,
    html: emailTemplateId
      ? undefined
      : `<p>${escapeHtml(entry.payload.body)}</p>`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
