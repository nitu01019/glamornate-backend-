# Firestore Rules Test Resolution

## Problem

`backend/functions/src/__tests__/firestore-rules.test.ts` failed to import
`@firebase/rules-unit-testing` because the package was listed in `devDependencies`
(`^5.0.0`) but never installed into `node_modules/@firebase/rules-unit-testing`.

Root cause: the monorepo root `package.json` registers `backend/functions` as an
npm workspace. Any `npm install` run from inside `backend/functions` resolves back
to the monorepo root and chokes on `workspace:*` protocol refs used by the pnpm
side of the monorepo — producing `EUNSUPPORTEDPROTOCOL`.

## Decision: A — Install

The test is complete, well-structured, and exercises real Firestore security rules
across 15+ collections. It uses an emulator-skip guard (`describeWithEmulator`) so
it never hard-fails in CI without the emulator. This is a high-value test asset
that should be kept and run.

## Commands Run

```bash
# Install bypassing npm's workspace auto-detection
cd backend/functions
npm_config_workspaces=false npm install --save-dev @firebase/rules-unit-testing@^5.0.0 --prefix .
# → added 1 package (^5.0.0 already in devDependencies, now physically present)

# Verify full suite still green
npx vitest run
# → Test Files: 34 passed (34) | Tests: 409 passed | 132 skipped (0 failed)
```

## Verification Result

```
Test Files  34 passed (34)
     Tests  409 passed | 132 skipped (541)
  Duration  730ms
```

Zero failed test files. The 132 skipped tests are the Firestore security rules
tests themselves — correctly skipped because the Firestore emulator is not running
in this environment. They will run (and are expected to pass) when the emulator is
started with `firebase emulators:start --only firestore`.

## Follow-up

To run the security rules tests fully:
1. `firebase emulators:start --only firestore` (requires Java + Firebase CLI)
2. In a second terminal: `cd backend/functions && npx vitest run`
3. The `Firestore Security Rules` describe block will execute instead of skip.
