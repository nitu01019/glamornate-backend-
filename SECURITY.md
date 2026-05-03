# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in the Glamornate backend (Cloud Functions, Firestore rules, Storage rules) or the deployed Glamornate app, please **do not** open a public issue.

Instead, email a private disclosure to: **security@glamornate.app** (or open a GitHub Security Advisory if you have access).

Particularly sensitive areas:
- Firestore Security Rules bypass / IDOR
- App Check evasion
- Cloud Function callable auth bypass
- Admin role escalation
- Pricing or booking-flow tampering

Include in your report:
- A description of the vulnerability and its potential impact
- Steps to reproduce (preferably with a test against the Firebase emulator, NOT production)
- Any proof-of-concept code or rule-test outputs
- Your contact information

## Disclosure Window

We commit to:
- Acknowledging receipt within 5 business days
- Providing an initial assessment within 14 days
- Coordinating public disclosure no earlier than 90 days after the fix is deployed

## Scope

In scope:
- This repository (Cloud Functions, firestore.rules, storage.rules, configs)
- The companion frontend repository (`glamornate-frontend`)
- The deployed production application's API surface

Out of scope:
- Social engineering, phishing, or physical security
- Third-party services (Firebase platform itself, MSG91, SendGrid, etc.) — please report to the respective vendor
- Spam or denial-of-service via traffic flooding without demonstrable downstream impact

## Safe Harbor

We will not pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations and disruption
- Only interact with their own accounts or accounts they have explicit permission to test
- **Use the Firebase emulator** for vulnerability research wherever possible (see `functions/docs/emulator_test_setup.md`)
- Report vulnerabilities promptly and in good faith
- Refrain from public disclosure until coordinated with us
