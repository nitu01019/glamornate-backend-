# Vendored: @glamornate/contracts

Backend-side vendored copy of the @glamornate/contracts package source
from the private monorepo. Single source of truth for Zod schemas and
shared TypeScript types between frontend and backend.

## Source of truth
Private monorepo at `packages/contracts/`. Refresh via maintainer script.

## Refresh procedure
```bash
MONOREPO_ROOT=/path/to/private/monorepo bash scripts/vendor-contracts.sh
```

## Imports
Inside `functions/`, import via relative paths from this directory.
Do NOT reintroduce `@glamornate/contracts` workspace specifiers.

## License
MIT (same as parent repo).
