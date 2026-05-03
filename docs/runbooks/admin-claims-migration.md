# Admin Custom-Claims Migration

## Overview

The Glamornate backend gates admin-only operations via two distinct
mechanisms today:

1. **Cloud Function callables** verify `request.auth` plus a Firestore
   `users/{uid}.role` lookup.
2. **Storage rules** and **Firestore rules** reach into Firestore via
   `get(/databases/$(db)/documents/users/$(request.auth.uid)).data.role`
   to derive role.

Mechanism (2) creates a defense-in-depth gap: if a future rule
regression ever lets users mutate the `role` field on their own
`users/{uid}` doc, full self-promotion to admin follows.

The fix is to migrate **rules** (mechanism 2) to use a Firebase Auth
custom claim that's set server-side (via Admin SDK) and is
cryptographically asserted by `request.auth.token.admin` in rules.

## Migration steps (operator)

This migration is GATED — do NOT deploy storage.rules / firestore.rules
changes that depend on `request.auth.token.admin` until ALL existing
admin users have the claim set.

### 1. List current admin uids

```bash
# From Firestore admin console or via gcloud:
gcloud firestore export gs://<temp-bucket>/admin-users-snapshot \
  --collection-ids=users
# Inspect the export and extract uids where role == 'admin'.
```

Alternatively, with `firebase-admin` from a trusted machine:

```ts
import * as admin from 'firebase-admin';
admin.initializeApp();

const snap = await admin.firestore()
  .collection('users')
  .where('role', '==', 'admin')
  .get();

console.log(snap.docs.map((d) => d.id));
```

### 2. Set custom claim for each admin

For each `<admin-uid>`, invoke the `setAdminClaim` callable from a
trusted client (e.g., Firebase emulator suite signed in as an existing
admin, or a one-shot Node script using the firebase-admin SDK directly).

The callable signature is:

```
input  : { targetUid: string }
output : { success: true, uid, claimsSet: { admin: true }, before: { role } }
errors :
  - unauthenticated     not signed in
  - permission-denied   caller's Firestore role is not 'admin'
  - invalid-argument    targetUid missing or empty
  - failed-precondition target's Firestore role is not 'admin'
  - not-found           target's Auth user does not exist
  - resource-exhausted  rate-limit (10 req/min/uid)
```

Example one-shot script using the Admin SDK directly (bypasses the
callable; useful when the migration runs from a build job):

```ts
// scripts/migrate-admin-claims.ts (one-shot)
import * as admin from 'firebase-admin';

admin.initializeApp();

async function main() {
  const uids = ['uid-1', 'uid-2', /* ... */];

  for (const uid of uids) {
    const user = await admin.auth().getUser(uid);
    await admin.auth().setCustomUserClaims(uid, {
      ...(user.customClaims ?? {}),
      admin: true,
    });
    console.log(`set admin claim for ${uid}`);
  }
}
main().catch(console.error);
```

Run with:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
  npx ts-node scripts/migrate-admin-claims.ts
```

Either path is idempotent: re-running for the same uid produces the
same end state.

### 3. Verify

For each `<admin-uid>`, force a token refresh (sign out, sign in) and
inspect the ID token. The token's payload should include `"admin": true`.

```bash
# Get fresh token from a signed-in admin client, decode at jwt.io
# OR via firebase-admin:
node -e "
  const admin = require('firebase-admin');
  admin.initializeApp();
  admin.auth().getUser('<admin-uid>').then(u => console.log(u.customClaims));
"
```

Expected output:

```
{ admin: true }
```

### 4. Update rules (separate PR — coordinated deploy)

ONLY after step 3 succeeds for all admins, update:

- `storage.rules` — replace `hasRole('admin')` (Firestore lookup) with
  `request.auth.token.admin == true`.
- `firestore.rules` — same migration in any rule using a role lookup
  for admin gates.

Deploy with:

```bash
firebase deploy --only firestore:rules,storage:rules \
  --project glamornate-758c6
```

### 5. Operational signals to watch for 24 hours after rules deploy

- Sentry for any spike in `permission-denied` errors from admin flows.
- Firestore audit logs for unexpected admin-rule denials.
- Manual smoke test: log in as each admin and verify dashboard access.

## Rollback

If admin flows break post-deploy, the fastest rollback is reverting
`storage.rules` / `firestore.rules` to the previous Firestore-doc-role
form. The custom claims set by step 2 are harmless to leave in place
(they're an additional capability, not a removed one), so revert is
rules-only.

## Why this matters

Custom claims are signed by Firebase and cannot be forged by a client.
A user who somehow corrupts their `users/{uid}.role` field cannot
escalate to admin under the new rules — they'd need their custom
claim toggled, which requires server-side admin invocation.

This is purely defense-in-depth; the existing Firestore allowlist on
`users/{uid}` updates already prevents role self-mutation. The custom
claim is a second line of defense in case that allowlist is ever
breached.

## Implementation reference

- Callable source: `functions/src/callable/setAdminClaim.ts`
- Tests: `functions/src/callable/__tests__/setAdminClaim.test.ts`
- Export: `functions/src/index.ts` (`setAdminClaim`)
