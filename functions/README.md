# backend/functions

Firebase Cloud Functions for Glamornate, written in TypeScript and deployed to
project `glamornate-758c6`. This package serves both an Express HTTP API
(`api` onRequest) and a fleet of callable / triggered / scheduled functions.

## Stack

Pinned versions from `package.json`:

- Node `20` (engine pin)
- `firebase-functions` `^5.1.0`
- `firebase-admin` `^13`
- `stripe` `^14.11.0`
- `express` `^4.19.2`
- `zod` `^3.22.4` for schema validation
- `twilio` `^5.0.0`, `@sendgrid/mail` `^8.1.3` for notifications
- `@google-cloud/tasks` `^5.0.0` for deferred work
- `algoliasearch` `^4.20.0` for search
- `date-fns` `^3.0.6` + `date-fns-tz` `^3.2.0` for IST handling
- TypeScript `^5.3.3`
- Vitest `^4.1.3` (with `@vitest/coverage-v8`)

Shared workspace packages are linked via `file:`:

- `@glamornate/contracts` (Zod request/response contracts)
- `@glamornate/data-catalog`

## Package manager: npm (NOT pnpm)

This package uses **npm** with `legacy-peer-deps=true` set in
`functions/.npmrc`. Required because some transitive dev dep peer-ranges
conflict with `firebase@^12` and were unblocking Cloud Build installs (see
commit `b12eda78`). Do not switch to pnpm or yarn — Firebase Cloud Build
expects an npm-resolvable lockfile.

```bash
cd backend/functions
npm install
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | `tsc` compile to `lib/`. |
| `npm run build:watch` | `tsc --watch` for live rebuilds. |
| `npm run serve` | Build, then start the functions emulator only. |
| `npm run shell` / `npm start` | Build, then `firebase functions:shell`. |
| `npm run deploy` | **Broken on this monorepo — do not use.** See deploy section below. |
| `npm run deploy:api` | Same caveat — use the wrapper script. |
| `npm run logs` | Tail Firebase function logs. |
| `npm run lint` / `lint:fix` | ESLint over `src/`. |
| `npm run test` | Vitest in watch mode. |
| `npm run test:run` | Vitest single run (CI). |
| `npm run test:coverage` | Vitest with v8 coverage. |
| `npm run seed:smoke` | Idempotent Firestore smoke seed (requires guard env vars; see backend/README.md). |
| `npm run verify:ttl` | Verify Firestore TTL field policies. |

## Source layout (`src/`)

| Directory | Contents |
|---|---|
| `index.ts` | Entry point — exports the `api` HTTP function plus all callables / triggers. |
| `callable/` | Firebase callable functions (booking flow, addresses, profile, vouchers, reviews, broadcast dispatch, etc.). |
| `http/` | `app.ts` builds the Express app; `routes/` and `middleware/` host the REST surface. |
| `triggered/` | Firestore / Auth / webhook event handlers. |
| `scheduled/` | Cron / pubsub-scheduled functions. |
| `events/` | Cross-cutting event publishers and subscribers. |
| `utils/` | Reusable infra: `withRateLimit`, `stripe`, `validator`, `notifications-outbox`, `bloom-filter`, `audit-log`, `secrets`, `error-handler`, `logger`, `metrics`, etc. |
| `data/` | Static catalog seeds (categories, services, promotions). |
| `types/` | Shared types (where present). |
| `__tests__/` | Vitest specs mirroring sibling source files. |

## Local dev

Build once, then start the emulator:

```bash
npm install
npm run build
npm run serve         # functions emulator on :5001
```

For full emulator suite (auth, firestore, storage, hosting, functions, UI):

```bash
firebase emulators:start --project glamornate-758c6
```

Emulator ports are defined in `../firebase.json`.

## Testing

Vitest is the test runner (not Jest, despite specs being colocated under
`__tests__/`). Specs live next to the unit they cover:

```
src/callable/createBookingDraft.ts
src/callable/__tests__/createBookingDraft.test.ts
```

Run:

```bash
npm run test:run                 # CI mode
npm run test                     # watch
npm run test:coverage            # coverage report
```

### withRateLimit mock cascade (REQUIRED)

Every callable spec must include a pass-through `vi.mock` of
`../utils/withRateLimit` at the top of the file, before any `import` of the
function under test:

```ts
vi.mock('../utils/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));
```

Without this shim the rate limiter swallows the call and tests fail in
non-obvious ways. This is enforced by convention across every callable test
in `__tests__/`.

### Firestore rules tests

`firestore-rules.test.ts` uses `@firebase/rules-unit-testing` against the
emulator. Start the firestore emulator before running this spec.

## Hardening already in place

Recent commits (see `git log` on `feat/industry-overhaul`) layered:

- **Rate limiting** via `utils/withRateLimit.ts` on every callable, **keyed by
  IP** rather than uid (closes anonymous-user evasion). Bloom filter–backed
  to bound write amplification.
- **Stripe webhook (REMOVED 2026-05-02)**: handler is a 14-day no-op stub
  returning 200; the spa now uses pay-at-spa exclusively. Deletion target
  2026-05-16. See [frontend/docs/runbooks/wave-12-stub-deletion.md](../../frontend/docs/runbooks/wave-12-stub-deletion.md)
  and [docs/adr/0009-stripe-removal.md](../../docs/adr/0009-stripe-removal.md).
- **Bloom-oracle replay defense** on idempotency keys (`utils/bloom-filter.ts`).
- **Storage IDOR closure** + filename validation tightening (commit `6e6aca74`).
- **Privilege-escalation surfaces** closed in Phase 8.5 (commit `119dd000`).
- **CSP `img-src` narrowed**, dead SendGrid validation pruned (commit `b5fa0f30`).
- **Phone field, storage rules, IP key, deploy hardening** (commit `c959b5d9`).
- **Gitleaks** scanning in CI for accidental secret commits.

When touching auth, payments, or rate-limit code, re-read the relevant commit
before opening a PR — security review is mandatory for those surfaces.

## Deploy

**Do not run `firebase deploy --only functions` directly** — `npm ci` fails
in Cloud Build because the workspace `file:` deps (`@glamornate/contracts`,
`@glamornate/data-catalog`) cannot resolve the parent `../../packages/`
directory in the upload.

Use the wrapper from the repo root or `backend/`:

```bash
bash backend/scripts/deploy-functions.sh                  # full deploy
bash backend/scripts/deploy-functions.sh api              # single function
bash backend/scripts/deploy-functions.sh --skip-install   # reuse staged install
```

The wrapper packs the workspace deps into tarballs inside
`backend/.deploy-staging/functions/`, rewrites the staged `package.json`,
installs cleanly outside the workspace, points `firebase.json` at the staged
source, deploys, and restores. See `backend/README.md` for the full rationale.

After deploy, run `bash backend/scripts/verify-deploy.sh` to probe the
public endpoints.
