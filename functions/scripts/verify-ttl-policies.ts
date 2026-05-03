#!/usr/bin/env ts-node
/**
 * Runtime verification of Firestore TTL policies.
 *
 * Queries the Firestore Admin API for each field that should have an active
 * TTL policy and exits non-zero if any TTL is missing or not ACTIVE.
 *
 * Usage:
 *   GCP_PROJECT_ID=glamornate-758c6 npm run verify:ttl
 *
 * Auth: uses Application Default Credentials (ADC). Locally, run
 *   `gcloud auth application-default login` first. In CI / on GCE,
 *   the runtime service account is used automatically.
 *
 * This script is intentionally NOT part of the main build graph — it is
 * opt-in via the `verify:ttl` npm script.
 */

import { google } from 'googleapis';

type FieldSpec = readonly [collection: string, field: string];

const FIELDS: ReadonlyArray<FieldSpec> = [
  ['notifications', 'expiresAt'],
  ['_processedStripeEvents', 'processedAt'],
  ['scheduled_reminders', 'expiresAt'],
  ['scheduled_notifications', 'expiresAt'],
  ['_rateLimits', 'expiresAt'],
] as const;

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'glamornate-758c6';
const DATABASE = process.env.GCP_FIRESTORE_DATABASE ?? '(default)';

interface FieldResponse {
  readonly ttlConfig?: {
    readonly state?: string;
  };
}

async function main(): Promise<void> {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/datastore'],
  });
  const firestore = google.firestore({ version: 'v1', auth });

  const failures: string[] = [];

  for (const [collection, field] of FIELDS) {
    const name = `projects/${PROJECT_ID}/databases/${DATABASE}/collectionGroups/${collection}/fields/${field}`;
    try {
      const res = await firestore.projects.databases.collectionGroups.fields.get({ name });
      const state = (res.data as FieldResponse).ttlConfig?.state;
      if (state !== 'ACTIVE') {
        failures.push(`${collection}.${field}: state=${state ?? 'MISSING'}`);
      } else {
        console.log(`ok  ${collection}.${field}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${collection}.${field}: error=${message}`);
    }
  }

  if (failures.length > 0) {
    console.error('FAIL:\n  ' + failures.join('\n  '));
    process.exit(1);
  }

  console.log(`\nAll ${FIELDS.length} TTL policies are ACTIVE.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
