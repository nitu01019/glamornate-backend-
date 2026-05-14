/**
 * Seed `spas/glamornate-default` + `spa_services/{glamornate-default}_{svcId}`
 * composites so the `createBooking` callable can resolve service pricing and
 * pass the Patch 9C "service offered by spa" precondition.
 *
 * Without this seed, every booking against the default spa fails with
 * `failed-precondition 'SERVICE_NOT_OFFERED_BY_SPA'`, surfaced to the user
 * as "Failed to create booking. Please check your input and try again."
 *
 * Idempotent: every doc upserted via REST PATCH (= Firestore set+merge).
 * Re-running picks up catalog edits without touching unrelated fields.
 *
 * Auth: uses `gcloud auth print-access-token` from the active gcloud account
 * because Firebase Admin SDK ADC on this machine is bound to a different
 * identity that lacks write IAM on glamornate-758c6. The active gcloud user
 * (project owner) has full Firestore access.
 *
 * Run:
 *   FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes \
 *     npm --prefix functions run seed:glamornate-spa
 */

import { execSync } from 'node:child_process';
// Use compiled output to avoid ESM resolution issues with workspace TS imports.
// Cast through unknown to skip type-check on the .js import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { catalogServices } =
  require('../functions/lib/shared/catalog/catalog') as {
    catalogServices: Array<{
      id: string;
      name: string;
      basePrice: number;
      durationMinutes: number;
      isActive: boolean;
    }>;
  };

const ALLOWED_PROJECTS = new Set(['glamornate-758c6', 'glamornate-staging']);
const projectId = process.env.FIREBASE_PROJECT_ID;
const confirm = process.env.CONFIRM_PROD_SEED;

if (!projectId || !ALLOWED_PROJECTS.has(projectId)) {
  // eslint-disable-next-line no-console
  console.error(
    `[seed:glamornate-spa] Aborted: FIREBASE_PROJECT_ID must be one of ${[
      ...ALLOWED_PROJECTS,
    ].join(', ')} (got "${projectId ?? '<unset>'}")`
  );
  process.exit(1);
}
if (confirm !== 'yes') {
  // eslint-disable-next-line no-console
  console.error(
    '[seed:glamornate-spa] Aborted: CONFIRM_PROD_SEED must equal "yes" to acknowledge this writes to live Firestore.'
  );
  process.exit(1);
}

const ACCESS_TOKEN = execSync('gcloud auth print-access-token', {
  encoding: 'utf8',
}).trim();

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

const SPA_ID = 'glamornate-default';

// --- Firestore REST value encoding ----------------------------------------
type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { arrayValue: { values: FsValue[] } }
  | { mapValue: { fields: Record<string, FsValue> } };

function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { stringValue: '' };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields: Record<string, FsValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = encodeValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function toFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}

// --- REST PATCH (idempotent upsert with merge) ----------------------------
async function upsertDoc(
  path: string,
  fields: Record<string, FsValue>
): Promise<void> {
  const url = `${FIRESTORE_BASE}/${path}`;
  // updateMask param tells Firestore to merge listed fields, leaving others
  // untouched. Without updateMask, PATCH replaces the entire document.
  const updateMask = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const res = await fetch(`${url}?${updateMask}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`upsertDoc ${path} failed: ${res.status} ${body}`);
  }
}

// --- Spa doc fixture ------------------------------------------------------
// Day-of-week keys MUST match what `availability.ts` looks up — the reader
// uses `Date.toLocaleDateString('en-US', { weekday: 'short' })` and lowers
// it, so the canonical key is the short form ("mon", "tue", "wed"…). The
// reader now also tolerates the long form for backward compat, but new
// seeds always write the short form to keep the data tidy.
const HOURS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].reduce<
  Record<string, { open: string; close: string; isOpen: boolean }>
>((acc, day) => {
  acc[day] = { open: '09:00', close: '21:00', isOpen: true };
  return acc;
}, {});

const NOW_ISO = new Date().toISOString();

async function seedSpaDoc(serviceIds: string[]): Promise<void> {
  await upsertDoc(
    `spas/${SPA_ID}`,
    toFsFields({
      id: SPA_ID,
      name: 'Glamornate, Jammu',
      slug: SPA_ID,
      description: 'Glamornate default home-services spa serving Jammu.',
      location: {
        address: 'Jammu',
        city: 'Jammu',
        state: 'Jammu and Kashmir',
        country: 'India',
        geo: { lat: 32.73, lng: 74.86 },
        timezone: 'Asia/Kolkata',
      },
      contact: { phone: '+919000000000', email: 'hello@glamornate.com' },
      categories: [
        'facials',
        'waxing',
        'manicure-pedicure',
        'clean-ups',
        'bleach',
        'de-tan-pack',
        'threading',
        'body-polishing-massage',
      ],
      amenities: ['home-service'],
      rating: { overall: 4.7, count: 120 },
      priceRange: { min: 99, max: 4999 },
      images: ['/images/spas/placeholder.webp'],
      status: 'active',
      isActive: true,
      services: serviceIds,
      operatingHours: HOURS,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
  );
  // eslint-disable-next-line no-console
  console.log(
    `[seed:glamornate-spa] spas/${SPA_ID} upserted (${serviceIds.length} services bound)`
  );
}

async function seedSpaServices(): Promise<number> {
  let writes = 0;
  // REST API doesn't have a batch endpoint with guaranteed atomicity, so we
  // just sequence the upserts. ~50 ms each × 100 = ~5 seconds. Acceptable.
  for (const svc of catalogServices) {
    if (!svc.isActive) continue;
    const compositeId = `${SPA_ID}_${svc.id}`;
    await upsertDoc(
      `spa_services/${compositeId}`,
      toFsFields({
        compositeId,
        spaId: SPA_ID,
        serviceId: svc.id,
        priceOverride: svc.basePrice,
        durationOverride: svc.durationMinutes,
        // Both `name` and `customName` are written. createBooking.ts:242
        // reads `spaServiceDoc.data()!.name`; legacy admin tooling reads
        // `customName`. Writing one without the other previously caused
        // every booking to 500 with Firestore rejecting the undefined
        // services[i].name field — see docs/runbooks if reintroducing.
        name: svc.name,
        customName: svc.name,
        isActive: svc.isActive,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      })
    );
    writes++;
    if (writes % 20 === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[seed:glamornate-spa] ... ${writes}/${catalogServices.length}`
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[seed:glamornate-spa] spa_services upserted: ${writes}`);
  return writes;
}

async function verifySample(): Promise<void> {
  const probes = ['svc-001', 'svc-002', 'svc-010'];
  for (const id of probes) {
    const compId = `${SPA_ID}_${id}`;
    const res = await fetch(`${FIRESTORE_BASE}/spa_services/${compId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[seed:glamornate-spa] WARN ${compId} not readable (${res.status})`
      );
      continue;
    }
    const doc = (await res.json()) as { fields?: Record<string, FsValue> };
    const f = doc.fields ?? {};
    const name =
      (f.customName as { stringValue?: string } | undefined)?.stringValue ??
      '?';
    const price =
      (f.priceOverride as { integerValue?: string } | undefined)
        ?.integerValue ?? '?';
    // eslint-disable-next-line no-console
    console.log(
      `[seed:glamornate-spa] verify ${compId}: name="${name}" priceOverride=${price}`
    );
  }
  const spaRes = await fetch(`${FIRESTORE_BASE}/spas/${SPA_ID}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const spaDoc = (await spaRes.json()) as { fields?: Record<string, FsValue> };
  const servicesField = spaDoc.fields?.services as
    | { arrayValue?: { values?: FsValue[] } }
    | undefined;
  const count = servicesField?.arrayValue?.values?.length ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    `[seed:glamornate-spa] verify spa doc exists=${spaRes.ok} servicesCount=${count}`
  );
}

async function main(): Promise<void> {
  const serviceIds = catalogServices.filter(s => s.isActive).map(s => s.id);
  await seedSpaDoc(serviceIds);
  await seedSpaServices();
  await verifySample();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[seed:glamornate-spa] FAILED', err);
    process.exit(1);
  });
