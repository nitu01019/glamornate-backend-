# Changelog

All notable changes to this public mirror are documented here.

The project adheres to [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

### Added
- `setAdminClaim` callable for migrating admin authorization from
  Firestore-doc role lookups to Firebase Auth custom claims.
- `docs/runbooks/admin-claims-migration.md` — operator runbook for the
  migration (gated; rules deploy must follow successful migration).
- `CHANGELOG.md` (this file).

### Documentation
- SMS architecture docs annotated with public-mirror disclaimer
  (production credentials live in private deployment, not here).

## [v0.1.0] — 2026-05-03

### Added
- Initial public mirror release with Cloud Functions package, Firestore
  + Storage rules, indexes, deploy/seed scripts.
- MIT LICENSE, CONTRIBUTING, SECURITY, issue templates.
- GitHub Actions CI + CodeQL + Firebase rules-test workflows.
- Branch protection on `main`.

### Security
- 32 callables wrap `withRateLimit` (Firestore-backed, cross-instance).
- All callables use `enforceAppCheck: true` via shared `callableOpts`.
- Server-authoritative pricing in `createBooking` ("client prices are
  never trusted").
- HTTP routes verify ID tokens with `checkRevoked: true`.

### Known limitations
- Backend `functions/` package references workspace deps via `file:../packages/*`;
  not buildable from clean clone until v0.2.0 vendoring lands.
