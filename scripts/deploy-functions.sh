#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Deploy Firebase Cloud Functions from an isolated staging directory.
#
# Why: functions/package.json uses `file:../../packages/*` for @glamornate/contracts
# and @glamornate/data-catalog. When firebase deploys, it only uploads the
# functions/ source - parent ../../packages/ is not present in Cloud Build, so
# `npm ci` fails. This script solves that by:
#   1. Building the shared packages
#   2. `npm pack` each as a .tgz tarball inside a clean staging dir
#   3. Rewriting the staging package.json to use the tarball paths
#   4. Installing fresh in staging (outside the monorepo workspace)
#   5. Temp-pointing firebase.json at the staging source
#   6. Deploying
#   7. Restoring firebase.json
#
# Usage:
#   bash backend/scripts/deploy-functions.sh                # full deploy
#   bash backend/scripts/deploy-functions.sh api            # single function
#   bash backend/scripts/deploy-functions.sh --skip-install # reuse existing install
# ------------------------------------------------------------------------------
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_DIR/.." && pwd)"
STAGING_DIR="$BACKEND_DIR/.deploy-staging/functions"
PROJECT="${FIREBASE_PROJECT:-glamornate-758c6}"
TARGET=""
SKIP_INSTALL=0
DEPLOY_MODE="default"  # default = functions + firestore:indexes (operator step 8)

for arg in "$@"; do
  case "$arg" in
    --skip-install)   SKIP_INSTALL=1 ;;
    --functions-only) DEPLOY_MODE="functions-only" ;;
    --rules-only)     DEPLOY_MODE="rules-only" ;;
    -*) ;;  # other flags ignored
    *)
      # First positional arg (not starting with -) = single-function target
      if [ -z "$TARGET" ]; then
        TARGET="$arg"
        DEPLOY_MODE="single-function"
      fi
      ;;
  esac
done

# Pre-flight: refuse to deploy if iCloud ghost files exist in source.
# iCloud Drive silently creates siblings like `index 2.ts`, `foo 3.js`,
# or bare `README 4` on sync conflicts. The numeric suffix increments
# on each conflict, so we glob `* [0-9].*` (and the bare `* [0-9]`
# variant) instead of hard-coding `* 2.*`. Without this, an iCloud
# duplicate that happened to be the third sync conflict would slip
# past the guard and corrupt the functions deploy.
GHOST_FILES=$(find "$BACKEND_DIR" -type f \( -name "* [0-9].*" -o -name "* [0-9]" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.deploy-staging/*" \
  -not -path "*/lib/*" \
  2>/dev/null || true)
if [ -n "$GHOST_FILES" ]; then
  echo "FATAL: iCloud ghost files present in backend source:"
  echo "$GHOST_FILES"
  echo ""
  echo "Delete them with:"
  echo "  find \"$BACKEND_DIR\" -type f \\( -name \"* [0-9].*\" -o -name \"* [0-9]\" \\) \\"
  echo "    -not -path \"*/node_modules/*\" -not -path \"*/.deploy-staging/*\" -delete"
  exit 1
fi

# Rules-only mode: skip all functions-related guards and staging — just deploy rules.
# This matches OPERATOR_GO_LIVE step 7 (post-migration rules narrowing).
if [ "$DEPLOY_MODE" = "rules-only" ]; then
  echo "[rules-only] Deploying Firestore rules to $PROJECT"
  cd "$BACKEND_DIR"
  firebase deploy --only firestore:rules --project="$PROJECT" --non-interactive
  echo ""
  echo "✓ Firestore rules deploy complete."
  exit 0
fi

# -------- Pre-flight: refuse prod deploy if ALLOW_APP_CHECK_DEBUG=true (P3-07b) --------
# Reason: ALLOW_APP_CHECK_DEBUG bypasses App Check enforcement in production — a
# serious security regression. This guard scans (a) the .env files, (b) firebase
# functions:config, (c) the currently-deployed runtime env for the flag.
echo "[guard] checking ALLOW_APP_CHECK_DEBUG..."

TARGET_PROJECT="${FIREBASE_PROJECT:-glamornate-758c6}"
IS_STAGING=0
case "$TARGET_PROJECT" in
  *staging*|*dev*|*preview*) IS_STAGING=1 ;;
esac

if [ "$IS_STAGING" = "0" ]; then
  # Scan env files
  FOUND=""
  for ef in \
    "$(dirname "$0")/../functions/.env" \
    "$(dirname "$0")/../functions/.env.production" \
    "$(dirname "$0")/../.env" \
    "$(dirname "$0")/../.env.production" \
  ; do
    if [ -f "$ef" ] && grep -E "^[[:space:]]*ALLOW_APP_CHECK_DEBUG[[:space:]]*=[[:space:]]*true" "$ef" >/dev/null 2>&1; then
      FOUND="$FOUND $ef"
    fi
  done

  if [ -n "$FOUND" ]; then
    echo "FATAL: ALLOW_APP_CHECK_DEBUG=true is set in prod-targeted env file(s):$FOUND"
    echo "Refusing to deploy to $TARGET_PROJECT. Remove the flag or deploy to a staging project instead."
    exit 1
  fi

  # Scan currently-running function env (if any functions exist)
  if command -v firebase >/dev/null 2>&1; then
    if firebase functions:config:get --project="$TARGET_PROJECT" 2>/dev/null | grep -i "allow_app_check_debug.*true" >/dev/null; then
      echo "FATAL: ALLOW_APP_CHECK_DEBUG=true present in firebase functions:config"
      exit 1
    fi
  fi
  echo "[guard] ALLOW_APP_CHECK_DEBUG OK"
else
  echo "[guard] skipping ALLOW_APP_CHECK_DEBUG check (staging project)"
fi

# Pre-flight: verify every secret referenced in source is bound in Secret Manager.
# Why: Firebase binds `defineSecret('X')` at deploy time; if X is not present in
# Secret Manager, the deployed function will throw `SECRET.value()` at first
# request. We fail fast here so the operator never ships a broken function.
# P3-07 (S-3-SECRETS). Skipped when SKIP_SECRET_CHECK=1 (e.g. CI preview deploys
# that intentionally run without vendor keys).
if [ "${SKIP_SECRET_CHECK:-0}" != "1" ]; then
  echo "[pre-flight] Verifying defineSecret() bindings against Secret Manager"
  DECLARED_SECRETS=$(grep -REo "defineSecret\(['\"][A-Z_]+['\"]\)" "$BACKEND_DIR/functions/src/" 2>/dev/null \
    | grep -oE "'[A-Z_]{4,}'|\"[A-Z_]{4,}\"" \
    | tr -d "'\"" \
    | sort -u)
  MISSING=""
  for s in $DECLARED_SECRETS; do
    if ! firebase functions:secrets:access "$s" --project="$PROJECT" >/dev/null 2>&1; then
      MISSING="$MISSING $s"
    fi
  done
  if [ -n "$MISSING" ]; then
    echo "FATAL: the following secrets are referenced in source but NOT bound in Secret Manager:"
    for s in $MISSING; do echo "  - $s"; done
    echo ""
    echo "Bind each with:"
    echo "  firebase functions:secrets:set <NAME> --project=$PROJECT --data-file=-"
    echo "  (paste the value on stdin and press Ctrl-D)"
    echo ""
    echo "Override (dev only): export SKIP_SECRET_CHECK=1"
    exit 1
  fi
  echo "[pre-flight] All $(echo "$DECLARED_SECRETS" | wc -w | tr -d ' ') declared secrets bound."
fi

# Pre-flight: run the functions test suite. A regression caught here
# is orders of magnitude cheaper than a Cloud Functions rollback.
# Override with `SKIP_TESTS=1` only for break-glass deploys (e.g. when
# the test runner itself is broken and the fix must ship hot).
if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  echo "[pre-deploy] running tests..."
  (cd "$BACKEND_DIR/functions" && npm run test:run) \
    || { echo "tests failed; aborting deploy. Override with SKIP_TESTS=1"; exit 1; }
fi

echo "[1/7] Building TypeScript source in functions/"
(cd "$BACKEND_DIR/functions" && npm run build)

echo "[2/7] Building shared monorepo packages"
(cd "$REPO_ROOT/packages/contracts" && npm run build)
(cd "$REPO_ROOT/packages/data-catalog" && npm run build)

echo "[3/7] Creating staging directory at $STAGING_DIR"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

echo "[4/7] Copying source to staging (excluding tests, node_modules, .turbo)"
rsync -a \
  --exclude='node_modules' \
  --exclude='.turbo' \
  --exclude='*.bak-*' \
  --exclude='*.log' \
  --exclude='*.tgz' \
  --exclude='__tests__' \
  --exclude='*.test.ts' \
  --exclude='*.test.js' \
  --exclude='*.test.js.map' \
  --exclude='*.emulator.test.*' \
  --exclude='vitest.config.*' \
  --exclude='.eslintrc.js' \
  --exclude='scripts' \
  --exclude='SOLUTION_PRD.md' \
  "$BACKEND_DIR/functions/" "$STAGING_DIR/"

echo "[5/7] Packing shared packages into staging"
cd "$STAGING_DIR"
npm pack "$REPO_ROOT/packages/contracts" > /dev/null
npm pack "$REPO_ROOT/packages/data-catalog" > /dev/null
python3 - <<'PYEOF'
import json, glob
with open('package.json') as f: p = json.load(f)
contracts_tgz = sorted(glob.glob('glamornate-contracts-*.tgz'))[-1]
catalog_tgz = sorted(glob.glob('glamornate-data-catalog-*.tgz'))[-1]
p['dependencies']['@glamornate/contracts']    = f'file:./{contracts_tgz}'
p['dependencies']['@glamornate/data-catalog'] = f'file:./{catalog_tgz}'
# devDependencies not needed in staging (lib/ already compiled locally)
p.pop('devDependencies', None)
# Minimize scripts - no tsc needed at deploy time
p['scripts'] = {'start': 'node lib/index.js'}
with open('package.json', 'w') as f:
  json.dump(p, f, indent=2); f.write('\n')
PYEOF

# .npmrc ensures Cloud Build's npm ci uses legacy-peer-deps
cat > .npmrc <<'RCEOF'
legacy-peer-deps=true
audit=false
fund=false
RCEOF

if [ "$SKIP_INSTALL" = "0" ]; then
  echo "[6/7] Installing deps in staging (no workspaces, ignore-scripts, legacy-peer-deps)"
  rm -f package-lock.json
  npm install \
    --ignore-scripts \
    --legacy-peer-deps \
    --no-audit \
    --no-fund \
    --no-workspaces
else
  echo "[6/7] --skip-install: reusing existing staging install"
fi

echo "[7/7] Deploying from staging"
cd "$BACKEND_DIR"
cp firebase.json firebase.json.bak-$$
trap 'mv firebase.json.bak-$$ firebase.json 2>/dev/null; exit' EXIT INT TERM
python3 - <<'PYEOF'
import json
with open('firebase.json') as f: d = json.load(f)
d['functions'][0]['source'] = '.deploy-staging/functions'
d['functions'][0].pop('predeploy', None)  # lib/ already built
with open('firebase.json', 'w') as f:
  json.dump(d, f, indent=2); f.write('\n')
PYEOF

FORCE_FLAG=""
case "$DEPLOY_MODE" in
  functions-only)
    DEPLOY_ARGS="--only functions"
    ;;
  single-function)
    DEPLOY_ARGS="--only functions:$TARGET"
    # Targeted deploy → keep `--force` so we don't get an interactive
    # `delete the others?` prompt for unaffected fns.
    FORCE_FLAG="--force"
    ;;
  default)
    # Operator step 8: deploy functions + firestore indexes
    # (rules deployed separately in step 7 with --rules-only)
    DEPLOY_ARGS="--only functions,firestore:indexes"
    ;;
  *)
    echo "FATAL: unknown DEPLOY_MODE=$DEPLOY_MODE"
    exit 1
    ;;
esac

# NOTE: `--force` is intentionally OMITTED for full deploys. Without
# it, `firebase deploy --only functions` will surface a confirmation
# prompt before deleting any function that disappeared from source —
# the safe default. With `--non-interactive` the CLI aborts on that
# prompt instead of silently deleting, which is exactly the behaviour
# we want for unattended (CI / scripted) full deploys.
NODE_OPTIONS="--max-old-space-size=8192" FUNCTIONS_DISCOVERY_TIMEOUT=300 \
  firebase deploy $DEPLOY_ARGS --project="$PROJECT" --non-interactive $FORCE_FLAG

mv firebase.json.bak-$$ firebase.json
trap - EXIT INT TERM
echo ""
echo "✓ Deploy complete. firebase.json restored."

# Post-deploy: smoke-test the deployed endpoints. Surfaces deploy-time
# regressions (cold-start crash, broken env, missing secret) before
# we declare victory. Override with `SKIP_VERIFY=1` if the verifier
# itself is broken or for offline deploys (e.g. preview tunnels).
if [[ "${SKIP_VERIFY:-0}" != "1" && -f "$BACKEND_DIR/scripts/verify-deploy.sh" ]]; then
  bash "$BACKEND_DIR/scripts/verify-deploy.sh" \
    || echo "verify-deploy reported issues; review before declaring deploy successful"
fi
