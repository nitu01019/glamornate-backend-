#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE_URL:-https://asia-south1-glamornate-758c6.cloudfunctions.net/api}"
echo "Verifying $BASE"
for path in /api/v1/health /api/v1/services/categories /api/v1/promotions /api/v1/search/trending '/api/v1/search?q=waxing'; do
  echo "GET $path"
  curl -sf -w "  HTTP %{http_code} in %{time_total}s\n" "$BASE$path" -o /dev/null
done
echo "All health checks passed."
