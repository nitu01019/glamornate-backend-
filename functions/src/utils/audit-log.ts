import * as admin from 'firebase-admin';
import { createHash, createHmac } from 'crypto';
import { createLogger } from './logger';
import { AUDIT_LOG_HMAC_KEY } from './secrets';

const logger = createLogger('audit-log');

/**
 * How long we retain audit log entries. We align with the longest legal
 * obligation we might be subject to: 7 years of transaction records for
 * any user who had a completed booking (Indian financial regs). For users
 * with no transactions the GDPR-friendly interpretation is the shorter
 * 180-day IT Rules 2021 window, but we choose to standardise on 7 years
 * so a single retention purge job can handle every case.
 */
export const AUDIT_LOG_RETENTION_YEARS = 7;

/**
 * Deterministic, one-way hash used to record PII in audit logs without
 * storing the raw value.
 *
 * SEC-M1: uses HMAC-SHA256 keyed with `AUDIT_LOG_HMAC_KEY` (Secret Manager).
 * Plain SHA-256 of, say, an email address is trivially rainbow-table-able —
 * HMAC with a server-side key makes the hashes unpekable by anyone who
 * obtains a snapshot of `audit_logs` without also holding the secret.
 *
 * Fallback: if the secret is not bound (local dev, unit tests) we fall
 * back to plain SHA-256. This keeps old test fixtures working but loses
 * the SEC-M1 guarantee — DO NOT ship to prod without binding the secret.
 * Set via `firebase functions:secrets:set AUDIT_LOG_HMAC_KEY`.
 */
export function hashPII(value: string | null | undefined): string | null {
  if (!value) return null;

  let key: string | undefined;
  try {
    key = AUDIT_LOG_HMAC_KEY.value();
  } catch {
    key = undefined;
  }

  if (key && key.length > 0) {
    return createHmac('sha256', key).update(String(value)).digest('hex');
  }

  // Fallback — logged once so operators notice during first deploy.
  logger.warn('AUDIT_LOG_HMAC_KEY not bound — falling back to plain SHA-256');
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Compute an ISO-8601 timestamp N years from `from` (default: now).
 */
export function addYearsIso(years: number, from: Date = new Date()): string {
  const date = new Date(from.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString();
}

export type AuditLogAction =
  | 'account_deleted'
  | 'account_deletion_started'
  | 'account_deletion_failed';

export interface AuditLogEntry {
  userId: string;
  action: AuditLogAction | string;
  entity?: {
    type: string;
    id: string;
  } | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requesterUid?: string | null;
  metadata?: Record<string, unknown> | null;
  /** ISO-8601 retention expiry — scheduler can purge after this date. */
  retentionUntil?: string | null;
}

export interface WrittenAuditLog extends AuditLogEntry {
  /** Firestore-generated document ID for the new log row. */
  logId: string;
  /** Server-side timestamp placeholder recorded in Firestore. */
  timestamp: FirebaseFirestore.FieldValue;
}

/**
 * Writes a single immutable audit log row to `audit_logs/{auto-id}`.
 *
 * The function always uses `serverTimestamp()` for the canonical event
 * time — clients/callers cannot forge this. The returned entry contains
 * the generated `logId` so callers can reference the row later.
 *
 * IMPORTANT: Callers should `await` this before performing any destructive
 * work they want recorded. If this write fails, the caller should abort
 * — the whole point of the log is that it survives the failure of later
 * steps.
 */
export async function writeAuditLog(
  entry: AuditLogEntry,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<WrittenAuditLog> {
  const ref = db.collection('audit_logs').doc();
  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  const retentionUntil =
    entry.retentionUntil ?? addYearsIso(AUDIT_LOG_RETENTION_YEARS);

  const row = {
    userId: entry.userId,
    action: entry.action,
    entity: entry.entity ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
    requesterUid: entry.requesterUid ?? entry.userId,
    metadata: entry.metadata ?? null,
    retentionUntil,
    timestamp: serverTimestamp,
  };

  await ref.set(row);

  logger.info('Audit log written', {
    logId: ref.id,
    userId: entry.userId,
    action: entry.action,
  });

  return { ...row, logId: ref.id };
}
