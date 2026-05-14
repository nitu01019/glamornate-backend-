/**
 * Standalone seed script — bypasses ts-node ESM resolution issues. Uses the
 * compiled functions/lib output for catalog data + REST PATCH for upserts.
 *
 * Run from /Users/nitishbhardwaj/Downloads/Glamornate/backend:
 *   FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes \
 *     node scripts/seed-glamornate-spa.mjs
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { catalogServices } = require('../functions/lib/shared/catalog/catalog.js');

const ALLOWED_PROJECTS = new Set(['glamornate-758c6', 'glamornate-staging']);
const projectId = process.env.FIREBASE_PROJECT_ID;
const confirm = process.env.CONFIRM_PROD_SEED;

if (!projectId || !ALLOWED_PROJECTS.has(projectId)) {
  console.error(
    `[seed:glamornate-spa] Aborted: FIREBASE_PROJECT_ID must be one of ${[...ALLOWED_PROJECTS].join(', ')} (got "${projectId ?? '<unset>'}")`,
  );
  process.exit(1);
}
if (confirm !== 'yes') {
  console.error(
    '[seed:glamornate-spa] Aborted: CONFIRM_PROD_SEED must equal "yes" to acknowledge this writes to live Firestore.',
  );
  process.exit(1);
}

const ACCESS_TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const SPA_ID = 'glamornate-default';

function encodeValue(v) {
  if (v === null || v === undefined) return { stringValue: '' };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encodeValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function toFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}

async function upsertDoc(path, fields) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const updateMask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
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

const HOURS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
].reduce((acc, day) => {
  acc[day] = { open: '09:00', close: '21:00', isOpen: true };
  return acc;
}, {});

const NOW_ISO = new Date().toISOString();

async function seedSpaDoc(serviceIds) {
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
        'facials', 'waxing', 'manicure-pedicure', 'clean-ups',
        'bleach', 'de-tan-pack', 'threading', 'body-polishing-massage',
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
    }),
  );
  console.log(`[seed:glamornate-spa] spas/${SPA_ID} upserted (${serviceIds.length} services bound)`);
}

async function seedSpaServices() {
  let writes = 0;
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
        name: svc.name,
        customName: svc.name,
        isActive: svc.isActive,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      }),
    );
    writes++;
    if (writes % 20 === 0) {
      console.log(`[seed:glamornate-spa] ... ${writes}/${catalogServices.length}`);
    }
  }
  console.log(`[seed:glamornate-spa] spa_services upserted: ${writes}`);
  return writes;
}

async function verifySample() {
  const probes = ['svc-001', 'svc-002', 'svc-010'];
  for (const id of probes) {
    const compId = `${SPA_ID}_${id}`;
    const res = await fetch(`${FIRESTORE_BASE}/spa_services/${compId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      console.warn(`[seed:glamornate-spa] WARN ${compId} not readable (${res.status})`);
      continue;
    }
    const doc = await res.json();
    const f = doc.fields ?? {};
    const name = f.customName?.stringValue ?? '?';
    const price = f.priceOverride?.integerValue ?? '?';
    console.log(`[seed:glamornate-spa] verify ${compId}: name="${name}" priceOverride=${price}`);
  }
  const spaRes = await fetch(`${FIRESTORE_BASE}/spas/${SPA_ID}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const spaDoc = await spaRes.json();
  const count = spaDoc.fields?.services?.arrayValue?.values?.length ?? 0;
  console.log(`[seed:glamornate-spa] verify spa doc exists=${spaRes.ok} servicesCount=${count}`);
}

async function main() {
  const serviceIds = catalogServices.filter((s) => s.isActive).map((s) => s.id);
  await seedSpaDoc(serviceIds);
  await seedSpaServices();
  await verifySample();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed:glamornate-spa] FAILED', err);
    process.exit(1);
  });
