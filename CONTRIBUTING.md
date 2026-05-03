# Contributing to Glamornate Backend

This repository is a **public source mirror** of an actively-developed production app's backend (Firebase Cloud Functions, Firestore rules, Storage rules). The canonical development happens in a private monorepo. As such:

## What this repo is for
- Code review and reference for the backend implementation
- Reading our security rules, callable function patterns, and operational runbooks
- Reporting bugs you observe in the deployed app's backend behavior

## What this repo is NOT for
- Direct pull requests (we are not currently accepting external PRs)
- Forking and deploying — see `.firebaserc` for our project ID; deploy from the private monorepo only

## How to report issues
File issues via the GitHub issue tracker using the templates in `.github/ISSUE_TEMPLATE/`. We aim to triage within 5 business days.

## Security disclosures
Backend security findings (authorization bugs, Firestore-rule bypasses, App Check evasion, etc.) are particularly sensitive. Please follow `SECURITY.md` for the private disclosure process. **Do not** file security issues in the public tracker.
