# Firebase Emulator Test Setup

## Overview

Emulator-gated tests connect to real Firebase emulators rather than in-process mocks.
Two test files require the emulator:

- `src/__tests__/firestore-rules.test.ts` — 132 Firestore Security Rules cases
- `src/callable/__tests__/deleteAccount.emulator.test.ts` — 6 end-to-end deleteAccount cases

Both files probe the emulator at module load time and self-skip gracefully when it is not
available, so the regular `npm run test:run` target is safe to use without emulators.

## Prerequisites

**Java** — required by Firebase emulators (Firestore runs on a JVM):

```bash
brew install openjdk
# The run-emulator-tests.sh script auto-adds /opt/homebrew/opt/openjdk/bin to PATH.
```

**Firebase CLI** — already installed globally (`firebase --version`).

**`@firebase/rules-unit-testing`** — listed in `devDependencies`. Because this package lives
in an npm island inside a pnpm monorepo, a plain `npm install` fails with
`EUNSUPPORTEDPROTOCOL: workspace:*` when npm walks up to the root `package.json`. The
`scripts/run-emulator-tests.sh` wrapper runs `npm install --workspaces=false` first to work
around this before launching the emulators.

## Running the emulator tests

```bash
# From backend/functions/
npm run test:emulator
```

The script (`scripts/run-emulator-tests.sh`) does three things:
1. Ensures `@firebase/rules-unit-testing` is installed (`npm install --workspaces=false`).
2. Starts the Firestore, Auth, and Storage emulators (`firebase emulators:exec`).
3. Runs `vitest run` inside the emulator process, then shuts the emulators down.

Expected output:

```
Test Files  34 passed (34)
      Tests  541 passed (541)
```

## Running individual test files under the emulator

```bash
npm install --workspaces=false
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
firebase --project demo-glamornate-rules-test --config ../firebase.json \
  emulators:exec --only firestore,auth,storage \
  './node_modules/.bin/vitest run src/__tests__/firestore-rules.test.ts'
```

## Key design decisions

- **Project ID `demo-glamornate-rules-test`** — Firebase treats any project starting with
  `demo-` as a local-only demo project; no real Firebase project is needed.
- **`--workspaces=false`** — prevents npm from walking up to the pnpm monorepo root and
  choking on `workspace:*` protocol references in `frontend/package.json`.
- **`emulators:exec` (not `emulators:start`)** — auto-starts emulators, runs the script,
  then shuts them down. No dangling processes.
- **`RULES_PATH`** in `firestore-rules.test.ts` resolves to `backend/firestore.rules`
  (3 levels up from `src/__tests__/`).
