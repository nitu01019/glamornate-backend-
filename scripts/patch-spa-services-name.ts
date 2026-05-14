/**
 * Patch every `spa_services/{spaId}_{serviceId}` doc to copy `customName` →
 * `name`. The createBooking callable reads `spaServiceDoc.data()!.name`
 * (lib/callable/createBooking.js:242) but the original seed wrote only
 * `customName`, so every booking attempt hit:
 *
 *   "Cannot use \"undefined\" as a Firestore value
 *    (found in field \"services.`0`.name\")"
 *
 * → 500 INTERNAL_ERROR → frontend toast "Failed to create booking…".
 *
 * This patch is the minimum data fix: copy `customName` → `name` and leave
 * everything else alone. Idempotent — re-running picks up any newly added
 * docs.
 *
 * Auth: same gcloud-token path as `seed-glamornate-spa.ts` because Admin
 * SDK ADC on this machine is bound to a different identity.
 *
 * Run:
 *   FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes \
 *     npm --prefix functions run patch:spa-services-name
 */

import { execSync } from 'node:child_process';

const ALLOWED_PROJECTS = new Set(['glamornate-758c6', 'glamornate-staging']);
const projectId = process.env.FIREBASE_PROJECT_ID;
const confirm = process.env.CONFIRM_PROD_SEED;

if (!projectId || !ALLOWED_PROJECTS.has(projectId)) {
  // eslint-disable-next-line no-console
  console.error(
    `[patch:spa-services-name] Aborted: FIREBASE_PROJECT_ID must be one of ${[
      ...ALLOWED_PROJECTS,
    ].join(', ')} (got "${projectId ?? '<unset>'}")`
  );
  process.exit(1);
}
if (confirm !== 'yes') {
  // eslint-disable-next-line no-console
  console.error(
    '[patch:spa-services-name] Aborted: CONFIRM_PROD_SEED must equal "yes" to acknowledge this writes to live Firestore.'
  );
  process.exit(1);
}

const ACCESS_TOKEN = execSync('gcloud auth print-access-token', {
  encoding: 'utf8',
}).trim();

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

interface FsDoc {
  name: string;
  fields?: Record<
    string,
    { stringValue?: string; integerValue?: string; booleanValue?: boolean }
  >;
}

interface FsListResp {
  documents?: FsDoc[];
  nextPageToken?: string;
}

async function listSpaServices(): Promise<FsDoc[]> {
  const all: FsDoc[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${FIRESTORE_BASE}/spa_services`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`list failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as FsListResp;
    if (body.documents) all.push(...body.documents);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return all;
}

async function patchDoc(docName: string, name: string): Promise<void> {
  // Update only the `name` field (updateMask) so we never clobber other state.
  const url = `https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=name`;
  const body = { fields: { name: { stringValue: name } } };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `patch ${docName} failed: ${res.status} ${await res.text()}`
    );
  }
}

async function main(): Promise<void> {
  const docs = await listSpaServices();
  // eslint-disable-next-line no-console
  console.log(
    `[patch:spa-services-name] Found ${docs.length} spa_services docs`
  );

  let patched = 0;
  let alreadyOk = 0;
  let skippedNoCustomName = 0;

  for (const doc of docs) {
    const fields = doc.fields ?? {};
    const existingName = fields.name?.stringValue;
    const customName = fields.customName?.stringValue;

    if (existingName && existingName.length > 0) {
      alreadyOk++;
      continue;
    }
    if (!customName) {
      skippedNoCustomName++;
      // eslint-disable-next-line no-console
      console.warn(
        `[patch:spa-services-name] WARN ${doc.name
          .split('/')
          .pop()} has no customName — skipping`
      );
      continue;
    }
    await patchDoc(doc.name, customName);
    patched++;
    if (patched % 25 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[patch:spa-services-name] ... ${patched} patched so far`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[patch:spa-services-name] DONE. patched=${patched} alreadyOk=${alreadyOk} skipped=${skippedNoCustomName}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[patch:spa-services-name] FAILED', err);
    process.exit(1);
  });
