/**
 * Sync the Firestore `services` collection with the canonical
 * `@glamornate/data-catalog` package — single source of truth.
 *
 * The frontend renders services from `catalogServices` (auto-generated
 * IDs `svc-001`…`svc-NNN`, `basePrice`, `durationMinutes`, etc.). The
 * backend `createBookingDraft` callable looks up `services/{id}.basePrice`
 * for server-side pricing. This seeder mirrors the catalog into Firestore
 * using the SAME ids and field names so the two never drift again.
 *
 * Idempotent: every doc is upserted with `{ merge: true }`. Re-running
 * picks up catalog edits (new services / price changes) without
 * touching unrelated fields.
 *
 * Guards:
 *   - `FIREBASE_PROJECT_ID` MUST equal `glamornate-758c6` (or staging).
 *   - `CONFIRM_PROD_SEED`   MUST equal `yes`.
 *
 * Run:
 *   FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes \
 *     npm --prefix functions run seed:catalog
 */

import * as admin from 'firebase-admin';
import { catalogServices } from '@glamornate/data-catalog';

// ---------------------------------------------------------------------------
// Env guards
// ---------------------------------------------------------------------------
const ALLOWED_PROJECTS = new Set(['glamornate-758c6', 'glamornate-staging']);
const projectId = process.env.FIREBASE_PROJECT_ID;
const confirm = process.env.CONFIRM_PROD_SEED;

if (!projectId || !ALLOWED_PROJECTS.has(projectId)) {
  // eslint-disable-next-line no-console
  console.error(
    `[seed:catalog] Aborted: FIREBASE_PROJECT_ID must be one of ${[
      ...ALLOWED_PROJECTS,
    ].join(', ')} (got "${projectId ?? '<unset>'}")`
  );
  process.exit(1);
}
if (confirm !== 'yes') {
  // eslint-disable-next-line no-console
  console.error(
    '[seed:catalog] Aborted: CONFIRM_PROD_SEED must equal "yes" to acknowledge this writes to live Firestore.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Admin SDK with default ADC
// ---------------------------------------------------------------------------
admin.initializeApp({ projectId });
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

/** Firestore batch size — well under the 500-write hard limit. */
const BATCH_SIZE = 400;

async function seedServices(): Promise<void> {
  const services = catalogServices;
  const total = services.length;
  // eslint-disable-next-line no-console
  console.log(`[seed:catalog] catalog has ${total} services to upsert`);

  let cursor = 0;
  let writes = 0;

  while (cursor < total) {
    const slice = services.slice(cursor, cursor + BATCH_SIZE);
    const batch = db.batch();

    for (const service of slice) {
      const ref = db.collection('services').doc(service.id);
      // Strip fields the booking pipeline will manage server-side.
      // Keep everything that contributes to pricing / display.
      batch.set(
        ref,
        {
          id: service.id,
          name: service.name,
          slug: service.slug,
          category: service.category,
          categorySlug: service.categorySlug,
          subcategory: service.subcategory ?? null,
          description: service.description,
          benefits: service.benefits,
          basePrice: service.basePrice,
          originalPrice: service.originalPrice ?? null,
          discountPercent: service.discountPercent ?? null,
          currency: service.currency,
          duration: service.duration,
          durationMinutes: service.durationMinutes,
          image: service.image,
          images: service.images,
          isLandscapeImage: service.isLandscapeImage ?? false,
          rating: service.rating,
          reviewCount: service.reviewCount,
          tags: service.tags,
          bookingCount: service.bookingCount,
          cities: service.cities,
          recommendedFor: service.recommendedFor,
          isActive: service.isActive,
          // Catalog `createdAt` is a string; preserve it but also write a
          // server timestamp on `updatedAt` so we can audit drift later.
          createdAt: service.createdAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      writes++;
    }

    await batch.commit();
    cursor += slice.length;
    // eslint-disable-next-line no-console
    console.log(`[seed:catalog]   committed batch — cursor=${cursor}/${total}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[seed:catalog] done: ${writes} services upserted to ${projectId}`
  );
}

async function verifySample(): Promise<void> {
  // Spot-check a few well-known IDs so the run output proves the upsert
  // landed (and shows the field names the booking callable expects).
  const probes = ['svc-001', 'svc-002', 'svc-010'];
  for (const id of probes) {
    const snap = await db.collection('services').doc(id).get();
    if (!snap.exists) {
      // eslint-disable-next-line no-console
      console.warn(
        `[seed:catalog] WARN ${id} missing after seed — investigate`
      );
      continue;
    }
    const d = snap.data() ?? {};
    // eslint-disable-next-line no-console
    console.log(
      `[seed:catalog] verify ${id}: name="${d.name}" basePrice=${d.basePrice} durationMinutes=${d.durationMinutes}`
    );
  }
}

async function main(): Promise<void> {
  await seedServices();
  await verifySample();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[seed:catalog] FAILED', err);
    process.exit(1);
  });
