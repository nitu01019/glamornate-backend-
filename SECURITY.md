# Security policy

Glamornate is a commercial spa-booking platform handling Firebase Auth (phone and Google), customer PII, and booking data. We take security reports seriously and aim to respond quickly.

> **REMOVED 2026-05-02** — Stripe handling was removed entirely; the spa now uses pay-at-spa exclusively. The 14-day grace stub at `backend/functions/src/events/handleStripeWebhook.ts` will be deleted on 2026-05-16 per [frontend/docs/runbooks/wave-12-stub-deletion.md](./frontend/docs/runbooks/wave-12-stub-deletion.md). See [docs/adr/0009-stripe-removal.md](./docs/adr/0009-stripe-removal.md) for the decision.

## Reporting a vulnerability

<!-- TODO: real reporting channel — tracked. Until set, use GitHub Security Advisory: https://github.com/<owner>/<repo>/security/advisories -->
Reporting channel: TODO (placeholder pending operator decision; see plan §7). Until a dedicated mailbox is provisioned, open a GitHub private security advisory on this monorepo. Encrypt sensitive details with PGP if available.

Alternative channel: once the repository is public, open a GitHub private security advisory on this monorepo. Do not file public issues for security matters.

Response targets:

- Acknowledgement: within 48 hours of receipt.
- Triage and severity assignment: within 5 business days.
- Fix or documented mitigation: 7 days for critical, 14 days for high, 30 days for medium and below.

Include in your report: affected component (frontend, backend, package), reproduction steps, impact assessment, and any proof-of-concept. Do not include real customer data.

## Scope

In scope:

- This monorepo: `frontend/`, `backend/functions/`, shared `packages/`.
- The production deployment (web app, Cloud Functions, Firestore rules, Storage rules).
- Build and deploy tooling that ships to production.

Out of scope:

- Third-party services: Firebase / Google Cloud, Google Identity, and their underlying infrastructure. Report those upstream. (Stripe was removed 2026-05-02 — see notice at top.)
- Volumetric denial-of-service.
- Social engineering of staff or customers.
- Physical attacks against infrastructure or personnel.
- Findings that require already-compromised devices, rooted phones, or attacker-controlled root CAs.
- Best-practice suggestions without a demonstrable impact (for example, missing security headers on non-sensitive endpoints).

## What we treat as critical

The following classes of issue are treated as critical and prioritized accordingly:

- Authentication or session bypass on Firebase Auth flows (phone or Google).
- Payment manipulation: amount tampering, currency swap, refund abuse, or any tampering with the pay-at-spa booking-amount fields. (Stripe webhook handling was removed 2026-05-02 — see notice at top.)
- PII exfiltration: customer profile, contact, booking history, or staff data accessed across tenants or roles.
- Privilege escalation: customer to staff, staff to admin, or cross-merchant access.
- Server-side remote code execution in Cloud Functions or build pipelines.
- IDOR on bookings, customers, payments, or storage objects.
- Secret leakage from `.env*` files, deploy artifacts, source maps, or build outputs.

## Responsible disclosure

Please do not publicly disclose details until a fix has shipped to production and affected users have been notified where required. We commit to:

- Keeping you informed of triage and remediation progress.
- Not pursuing legal action against good-faith researchers who follow this policy.
- Crediting reporters in release notes or a security acknowledgements page when requested.

## Hardening already in place

The codebase ships with the following defenses. New issues should be evaluated against this baseline:

- Firestore security rules enforce tenant and role boundaries; rules are tested in `backend/functions/src/__tests__/firestore-rules.test.ts`.
- Cloud Functions run with least-privilege IAM and validate caller identity on every callable.
- Per-caller rate limiting via `withRateLimit` wraps all callable functions; tests use a pass-through mock to preserve coverage.
- ~~Stripe webhook handler~~ **REMOVED 2026-05-02** — Stripe was removed entirely; the spa now uses pay-at-spa exclusively. The handler is a 14-day no-op stub returning 200, deletion target 2026-05-16. See [docs/adr/0009-stripe-removal.md](./docs/adr/0009-stripe-removal.md).
- Bloom-oracle replay defense remains for any future idempotent webhook traffic.
- Secret scanning via `gitleaks` configured in `.gitleaks.toml` and run in CI.
- Content Security Policy with narrowed `img-src` (commit `b5fa0f30`).
- Storage IDOR surfaces closed and filename validation tightened (commit `6e6aca74`).
- Three privilege-escalation surfaces closed in Phase 8.5 (commit `119dd000`).
- Phone field handling, storage rules, Bloom oracle key derivation, and IP-key handling hardened pre-deploy (commit `c959b5d9`).

## Secrets management

- Never commit `.env`, `.env.local`, `.env.production`, or any other `.env*` file. They are gitignored at every level of the monorepo.
- `backend/.deploy-staging/` is gitignored to prevent leaked deploy artifacts (compiled functions, copied env files, service-account JSON).
- Service-account keys live in Google Secret Manager or Firebase Functions config — never in source. (Stripe keys are no longer required as of 2026-05-02 — see notice at top.)
- If a secret is exposed in any commit, branch, log, or artifact: rotate it immediately, force-invalidate dependent sessions or tokens, and audit access logs for the exposure window. Notify the security contact before rewriting history.
- Production deploys must use the `backend/scripts/deploy-functions.sh` wrapper, which avoids leaking workspace files into the deploy bundle.

## Supported versions

Only the `main` branch is supported. Prior tags and feature branches do not receive security backports. This is a commercial product, not an OSS library; there is no LTS.

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| Other   | No        |

Customers running self-hosted forks are responsible for tracking upstream security commits.
