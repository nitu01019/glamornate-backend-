#!/usr/bin/env bash
# Refresh functions/src/lib/data-catalog/ from a sibling private monorepo.
# Maintainer-only.
#
# Usage:
#   MONOREPO_ROOT=/path/to/private/monorepo bash scripts/vendor-data-catalog.sh

set -euo pipefail

if [[ -z "${MONOREPO_ROOT:-}" ]]; then
  echo "Set MONOREPO_ROOT to the private monorepo root."
  exit 1
fi

SRC="$MONOREPO_ROOT/packages/data-catalog/src/"
DEST="$(cd "$(dirname "$0")/.." && pwd)/functions/src/lib/data-catalog/"

[[ -d "$SRC" ]] || { echo "Source not found: $SRC"; exit 1; }

cp "$DEST/VENDORED.md" /tmp/.vendored-be-data-catalog
rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a --exclude='*.test.ts' --exclude='__tests__' "$SRC" "$DEST"
mv /tmp/.vendored-be-data-catalog "$DEST/VENDORED.md"

echo "Vendored: $SRC -> $DEST"
