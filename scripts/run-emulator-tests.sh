#!/usr/bin/env bash
# Runs emulator-gated Vitest tests.
# Prerequisites: firebase-tools, Java (OpenJDK via brew install openjdk)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FUNCTIONS_DIR="$BACKEND_DIR/functions"

# Ensure OpenJDK (installed via brew) is on PATH
if [ -d "/opt/homebrew/opt/openjdk/bin" ]; then
  export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
elif [ -d "/usr/local/opt/openjdk/bin" ]; then
  export PATH="/usr/local/opt/openjdk/bin:$PATH"
fi

# Verify java is available
if ! command -v java &>/dev/null; then
  echo "ERROR: Java not found. Install with: brew install openjdk" >&2
  exit 1
fi

# Ensure @firebase/rules-unit-testing is installed.
# Must use --workspaces=false because this package lives in an npm island
# inside a pnpm monorepo; standard npm install walks up and chokes on
# workspace:* protocol refs in the pnpm-managed frontend package.json.
if [ ! -d "$FUNCTIONS_DIR/node_modules/@firebase/rules-unit-testing" ]; then
  echo "Installing @firebase/rules-unit-testing..."
  (cd "$FUNCTIONS_DIR" && npm install --workspaces=false --silent)
fi

cd "$FUNCTIONS_DIR"

exec firebase \
  --project demo-glamornate-rules-test \
  --config "$BACKEND_DIR/firebase.json" \
  emulators:exec \
  --only firestore,auth,storage \
  './node_modules/.bin/vitest run'
