# Vendored: @glamornate/data-catalog

Backend-side vendored copy of the @glamornate/data-catalog package
source from the private monorepo. Curated spa service catalog used
by Cloud Functions for pricing, availability, and search.

## Source of truth
Private monorepo at `packages/data-catalog/`. Refresh via maintainer script.

## Refresh procedure
```bash
MONOREPO_ROOT=/path/to/private/monorepo bash scripts/vendor-data-catalog.sh
```

## Imports
Inside `functions/`, import via relative paths from this directory.
Do NOT reintroduce `@glamornate/data-catalog` workspace specifiers.

## License
MIT (same as parent repo).
