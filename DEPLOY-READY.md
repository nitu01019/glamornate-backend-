# Backend Deploy Readiness — 2026-04-17

## Status: READY

All Phase 1 prep items complete. One command from user deploys everything.

## What the user must do

1. Upgrade Firebase project to Blaze plan:
   https://console.firebase.google.com/project/glamornate-758c6/usage/details
   → Modify plan → Blaze
2. Confirm billing is active (should show "Blaze (Pay as you go)" on the usage page)
3. Run from the backend directory:
   ```bash
   cd /Users/nitishbhardwaj/Desktop/Glamornate/backend
   firebase deploy --only functions:api,firestore:indexes,firestore:rules --project glamornate-758c6
   ```
4. After deploy, seed Firestore:
   ```bash
   cd /Users/nitishbhardwaj/Desktop/Glamornate/backend/functions
   FIREBASE_PROJECT_ID=glamornate-758c6 CONFIRM_PROD_SEED=yes npm run seed:smoke
   ```
5. Verify endpoints:
   ```bash
   /Users/nitishbhardwaj/Desktop/Glamornate/backend/scripts/verify-deploy.sh
   ```

## What was done in this prep pass

1. **Verified backend state** — `src/index.ts` exports `api = onRequest({ region: 'asia-south1', memory: '512MiB', timeoutSeconds: 60, minInstances: 1, invoker: 'public' }, httpApp)`. Confirmed `src/http/app.ts` mounts middleware in the order `cors → verifyAppCheck → rateLimit → verifyAuth`. All route files present.
2. **Wired `/spas` to Firestore** — `src/http/routes/spas.ts` now queries the live `spas` collection: `where('status','==','active')` plus optional `where('city','==',…)`, ordered by `featuredRank asc, name asc`, with cursor-based pagination using the last document id as the `after` cursor. `/spas/:id` fetches the spa doc and its `services` subcollection (limit 50).
3. **Wired `/bookings` to Firestore** — `src/http/routes/bookings.ts` adds `GET /bookings/:id` (auth-required, authz against `userId || customerId || spaOwnerId`, **403 Forbidden** on cross-user, NOT 404) and `GET /bookings` (per-uid list, paginated, `orderBy createdAt desc`). Unit tests cover 401 no-auth, 404 missing, 403 cross-user, 200 customer + spa owner, list pagination.
4. **Seed script** — `scripts/seed-smoke-data.ts`. Idempotent merge writes. Guards on `FIREBASE_PROJECT_ID=glamornate-758c6` and `CONFIRM_PROD_SEED=yes`. Seeds 8 categories, 12 services, 3 promotions (percent / flat / deal-of-day), 6 Pune spas with 3 nested services each, and 10 trending searches. Uses `firebase-admin` with ADC.
5. **`verify-deploy.sh`** — curl-probes `/health`, `/services/categories`, `/promotions`, `/search/trending`, `/search?q=waxing`. chmod +x.
6. **CORS allowlist** — Confirmed allowlist is exactly `['https://glamornate.vercel.app', 'https://glamornate.com', 'https://localhost', 'capacitor://localhost', /^http:\/\/localhost(:\d+)?$/]`. Unit test verifies all 5 origins + rejection.
7. **App Check middleware** — Confirmed reads `X-Firebase-AppCheck`, calls `admin.appCheck().verifyToken(token)`, has `ALLOW_APP_CHECK_DEBUG=true` bypass, returns 401 with `{ code: 'app-check-failed' }` on failure (added `code` field alongside the shared error envelope).
8. **Firestore rules audit** — Confirmed `/bookings/{id}` read allows owner + spa owner/staff + admin; `/reviews/{id}` create requires `userId == request.auth.uid`; `/users/{uid}` update is `hasOnly` restricted to non-role fields so clients cannot escalate. Composite indexes added: `spas(status, city, featuredRank, name)` and `spas(status, featuredRank, name)` for the new list queries.
9. **Tests** — Added `__tests__/http/spas.test.ts` (4 cases) and `__tests__/http/bookings.test.ts` (8 cases). Both mock `firebase-admin` for hermetic runs. Total HTTP test count: 36, all passing. Build clean.

## What was NOT done (out of scope)

- Actual `firebase deploy` (user is still on Spark; will run after Blaze upgrade)
- `firebase deploy --dry-run` (v2 functions dry-run also requires Blaze)
- Hitting live endpoints (nothing is deployed)
- Configuring Play Integrity / ReCaptcha v3 keys in Firebase Console (user's manual step)
- Fixing pre-existing failures in `createBookingDraft.test.ts` and `handleStripeWebhook.test.ts` (out of Phase 1 prep scope; unrelated to HTTP wiring)

## Sanity-check commands (safe; do NOT deploy anything)

```bash
# Should print "Current project: glamornate-758c6"
firebase use --project glamornate-758c6

# Compile check
cd backend/functions && npm run build

# Run the HTTP contract + route tests
cd backend/functions && npx vitest run src/__tests__/http/
```
