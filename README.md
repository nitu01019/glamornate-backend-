# backend

Firebase project wrapper for Glamornate. Holds Firestore/Storage rules, indexes,
hosting config, and the Cloud Functions package. Project ID: `glamornate-758c6`.

This directory is **not** an npm package. The actual installable code lives in
`functions/`. Everything else here is Firebase configuration and operational
tooling.

## Layout

| Path | Purpose |
|---|---|
| `firebase.json` | Firebase CLI config — wires rules, functions source, storage, hosting, and emulator ports. |
| `firestore.rules` | Firestore security rules (single source of truth). |
| `firestore.indexes.json` | Composite index definitions deployed alongside rules. |
| `storage.rules` | Cloud Storage security rules. |
| `storage-lifecycle.json` | GCS lifecycle policy (object expiration / class transitions). |
| `.firebaserc` | Project alias mapping. |
| `functions/` | Cloud Functions package — see `functions/README.md` for the full `src/` subtree (`index.ts`, `callable/`, `http/`, `events/`, `triggered/`, `scheduled/`, `data/`). |
| `scripts/` | Deploy + seed scripts (`deploy-functions.sh`, `seed-firebase.ts`, `seed-smoke-data.ts`, `verify-deploy.sh`). |
| `docs/` | Operational docs. |
| `.deploy-staging/` | **Gitignored.** Scratch directory created by `deploy-functions.sh`; do not edit by hand. |

Hosting `public` points at `../frontend/out` — the static export from the
Next.js app. See `firebase.json` for full hosting headers and rewrites.

## Local development

The functions package is the only installable unit here. Build and test from
inside it:

```bash
cd backend/functions
npm install
npm run build
npm run test:run           # vitest; HTTP contract tests + app check + cors
```

Emulator-driven flows are covered under [Emulators](#emulators) below.

## Deploy

**Always use the wrapper script for functions:**

```bash
bash backend/scripts/deploy-functions.sh                  # full functions deploy
bash backend/scripts/deploy-functions.sh api              # single function
bash backend/scripts/deploy-functions.sh --skip-install   # reuse staging install
```

### Why the wrapper exists

`functions/package.json` declares the shared workspace packages as file links:

```
"@glamornate/contracts":   "file:../../packages/contracts"
"@glamornate/data-catalog": "file:../../packages/data-catalog"
```

When `firebase deploy --only functions` runs, Cloud Build only uploads the
`functions/` source tree — the parent `../../packages/` directory is not
present, so `npm ci` fails resolving the `file:` deps. **Direct
`firebase deploy --only functions` is broken on this monorepo.**

`scripts/deploy-functions.sh` works around this by:

1. Building each shared package locally
2. `npm pack`-ing them into tarballs inside `backend/.deploy-staging/functions/`
3. Rewriting the staged `package.json` to point at the tarball paths
4. Running a clean install in the staging dir (outside the workspace)
5. Temporarily pointing `firebase.json` at the staged source
6. Deploying
7. Restoring `firebase.json`

If you see `npm ci` failures referencing `@glamornate/contracts` during
deploy, you ran the wrong command — switch to the wrapper.

## Rules-only deploys

Firestore / Storage rule and index changes do not involve the monorepo file
deps; the standard Firebase CLI is fine:

```bash
firebase deploy --only firestore:rules    --project glamornate-758c6
firebase deploy --only firestore:indexes  --project glamornate-758c6
firebase deploy --only storage            --project glamornate-758c6
firebase deploy --only hosting            --project glamornate-758c6
```

## Seeding / smoke data

Idempotent seed populating Firestore with enough data to smoke-test the mobile
app against a real project. Both env vars are required (the script aborts
otherwise):

- `FIREBASE_PROJECT_ID=glamornate-758c6`
- `CONFIRM_PROD_SEED=yes`

What it writes (all via `set(..., { merge: true })` so re-runs are safe):

| Collection         | Count | Notes                                                              |
| ------------------ | ----- | ------------------------------------------------------------------ |
| `categories`       | 8     | id = slug; matches the frontend `catalogCategories` shape          |
| `services`         | 12    | 4 services across 3 categories (facials, waxing, manicure-pedicure) |
| `promotions`       | 3     | one `discountType: percent`, one `flat`, one `dealOfDay`           |
| `spas`             | 6     | city = `pune`, various `featuredRank`, each with 3 nested services |
| `trendingSearches` | 10    | `{term, displayRank}`                                              |

Run:

```bash
cd backend/functions
FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes npm run seed:smoke
```

Uses `firebase-admin` with Application Default Credentials
(`gcloud auth application-default login`). No client SDK keys involved.

## Smoke verification

After deploy, probe the public endpoints:

```bash
bash backend/scripts/verify-deploy.sh
# Or override base URL:
BASE_URL=https://asia-south1-glamornate-758c6.cloudfunctions.net/api \
  bash backend/scripts/verify-deploy.sh
```

The script `curl -sf`-probes:

- `/api/v1/health`
- `/services/categories`
- `/promotions`
- `/search/trending`
- `/search?q=waxing`

A non-zero exit means at least one endpoint failed — investigate before
declaring the deploy green.

## Emulators

Ports from `firebase.json`:

| Service   | Port |
|-----------|------|
| auth      | 9099 |
| functions | 5001 |
| firestore | 8080 |
| storage   | 9199 |
| hosting   | 5000 |
| ui        | 4000 |

Start with `firebase emulators:start` from this directory, or use the
`functions/` script `npm run serve` to build + start functions emulator only.

## Further reading

- `functions/README.md` — function authoring, `src/` subtree, scripts, testing conventions, hardening notes
- `DEPLOY-READY.md` — pre-flight deploy checklist
- `docs/` — operational runbooks
