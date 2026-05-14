# SMS Architecture — Glamornate Backend

> Written: 2026-04-27  
> Author: architect (glamornate-fix-v2 team)  
> Revision: 2 — Updated after team-lead review; AWS SNS rejected, Firebase Extension selected.  
> Status: APPROVED FOR IMPLEMENTATION

---

## Section 1 — What Firebase Actually Offers for SMS

Firebase itself has **no public Admin SDK API for sending arbitrary transactional SMS**. The following paths exist but each has limits:

| Firebase feature | SMS capability | Limitation |
|---|---|---|
| **Firebase Auth `signInWithPhoneNumber`** | Sends a 6-digit OTP to the user's phone | OTP only. Cannot customize message body. Cannot trigger from backend. Requires RecaptchaVerifier client-side flow. |
| **Identity Platform Multi-Factor Authentication** | Sends MFA enrollment OTP | OTP only. Same carrier infra as Auth. No arbitrary body. |
| **Firebase Extensions Marketplace** | Extensions like `msg91/msg91-send-msg`, `messagebird/firestore-messagebird-send-msg` wrap non-Twilio SMS carriers. Installed via `firebase ext:install`, run as Cloud Functions, triggered by Firestore document writes. | Carrier is third-party, but the developer surface is Firebase — installed via Firebase CLI, orchestrated by Firestore triggers, managed like any other Firebase resource. This IS Firebase-native SMS. |
| **Firebase Cloud Messaging (FCM)** | Rich push notifications to Android/iOS/web | Push only, NOT SMS. Requires app install + active FCM token. |

**Conclusion:** "Firebase-native SMS" means a Firebase Extension that wraps a non-Twilio SMS carrier. The extension is installed via the Firebase CLI, runs as a Cloud Function inside the project, and is triggered by a Firestore document write — the same pattern used by "Trigger Email from Firestore" (the most popular Firebase messaging extension, 40.8K+ installs). The underlying SMS carrier is third-party, but everything the developer touches (CLI, Firestore, Cloud Functions) is Firebase.

**References:**
- MSG91 Firebase Extension: https://extensions.dev/extensions/msg91/msg91-send-msg
- MessageBird Firebase Extension: https://extensions.dev/extensions/messagebird/firestore-messagebird-send-msg
- Firebase Extensions install docs: https://firebase.google.com/docs/extensions/install-extensions

---

## Section 2 — What This Project Currently Has

### Phone Auth (sign-in only)

Firebase Phone Auth is wired in the **frontend only** for authentication:

- `frontend/src/app/auth/_components/SignInWithPhoneForm.tsx` — two-step OTP sign-in form using `signInWithPhoneNumber` + `RecaptchaVerifier`.
- `frontend/src/lib/firebase-client/index.ts:290` — `sendPhoneOTP` wrapper calling `signInWithPhoneNumber`.
- `backend/functions/src/callable/checkSignupAvailability.ts` — checks phone availability at signup. Does NOT send SMS.

**Scope:** Phone Auth is used **for user authentication only**. It has never sent transactional notifications.

### Notifications Outbox Infrastructure

The outbox infrastructure (`backend/functions/src/utils/notifications-outbox.ts`) already has full SMS channel support:

- `NotificationChannel = 'fcm' | 'email' | 'sms'` (line 54)
- `LegacyNotificationContext.sms?: { to?: string; body?: string }` (lines 154-157)
- `enqueueNotificationFromContext` already writes `smsTo` and `smsBody` into `payload.data` (lines 200-201)

The outbox worker (`processNotificationsOutbox.ts`) has `fcm` and `email` branches in `dispatchChannels` but **no `sms` branch** (lines 149-178). The `sms` channel is accepted but silently not dispatched.

### Twilio Tombstone

`backend/functions/src/utils/notifications.ts:9`:
```
// Twilio: removed M-TWILIO-REMOVE 2026-04-25 — phone OTP via Firebase Auth, push via FCM.
```

Twilio was the previous SMS carrier. It has been fully removed from `package.json` and source code.

### No Firebase Extensions (yet)

No `extensions.yml` or Firebase Extension manifest exists in this repository. No extension has been installed on the glamornate-758c6 project. The extension install is a one-time operator action via the Firebase CLI.

---

## Section 3 — Recommended Path: Firebase Extension (MSG91)

### Chosen extension: `msg91/msg91-send-msg`

**Extension ID:** `msg91/msg91-send-msg@0.0.3`  
**Install command:** `firebase ext:install msg91/msg91-send-msg --project glamornate-758c6`  
**Marketplace:** https://extensions.dev/extensions/msg91/msg91-send-msg

### Why MSG91 over MessageBird?

| Factor | MSG91 | MessageBird |
|---|---|---|
| India focus | YES — India-native provider, competitive DLT rates | NO — global provider, higher India SMS cost |
| Firestore trigger pattern | YES — writes doc triggers extension dispatches SMS | YES — same Firestore-trigger pattern |
| Installs | 100+ | 400+ |
| Channel setup complexity | Simple (Auth Key only) | Requires creating SMS "channel" and acquiring a sending number |
| DLT compliance (India) | Built-in — MSG91 handles DLT registration for Indian routes | Requires separate DLT setup |
| Cost (India) | ~0.16-0.25 per SMS (INR) | Higher for India routes |

MSG91 is India-native, handles DLT (Distributed Ledger Technology) compliance required for Indian SMS routes, and requires only an Auth Key — simpler setup than MessageBird.

### How the Firebase Extension integration works

The MSG91 extension follows the standard Firebase Extension Firestore-trigger pattern:

1. **Operator installs** the extension once via `firebase ext:install`. This deploys a Cloud Function in the project that watches a Firestore collection (configurable, we use `sms_dispatch`).
2. **Backend code writes** a document to that collection: `{ to: "+919876543210", message: "Your therapist is en route" }`.
3. **Extension's Cloud Function triggers**, calls MSG91's API, sends the SMS.
4. **Extension updates** the document with delivery status.

`sendSmsNotification` in `notifications.ts` writes a Firestore document. The extension handles the rest. This is identical in spirit to how "Trigger Email from Firestore" works — no npm HTTP client needed.

### Why not a direct HTTP call to a non-Firebase SMS provider?

Direct HTTP calls (AWS SNS, MessageBird npm client, Vonage npm, etc.) add a non-Firebase npm SDK dependency. Firebase Extensions are explicitly Firebase-native: installed via Firebase CLI, managed via Firebase console, triggered by Firebase services (Firestore). The user's constraint was Firebase-native, not just "any non-Twilio provider."

### Why not Firebase Auth Phone OTP?

Firebase Auth's `signInWithPhoneNumber` cannot send arbitrary text messages. It sends only 6-digit OTPs as part of an authentication flow. Using it for booking notifications would violate Firebase ToS and is architecturally wrong.

---

## Section 4 — Concrete API Surface

### Extension collection

The MSG91 extension watches a configurable Firestore collection. We name it `sms_dispatch` (separate from `notifications_outbox` to keep extension-managed state isolated from the outbox worker's own retry logic).

### Function signature

```typescript
// Location: backend/functions/src/utils/notifications.ts
// Add AFTER sendEmailNotification, BEFORE end of file

export interface SmsPayload {
  to: string;      // E.164 format: "+919876543210"
  body: string;    // Max 160 chars for a single SMS segment
}

export async function sendSmsNotification(
  payload: SmsPayload,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<boolean>
```

### Implementation

```typescript
// Collection watched by MSG91 Firebase Extension (msg91/msg91-send-msg).
// Extension install sets this up; we read the name from env with fallback.
const SMS_DISPATCH_COLLECTION =
  process.env.MSG91_COLLECTION_NAME ?? 'sms_dispatch';

export async function sendSmsNotification(
  payload: SmsPayload,
  db: FirebaseFirestore.Firestore = admin.firestore()
): Promise<boolean> {
  if (!payload.to || !payload.body) {
    logger.warn('sendSmsNotification: missing to or body — skipping', {
      to: payload.to,
    });
    return false;
  }

  try {
    const ref = db.collection(SMS_DISPATCH_COLLECTION).doc();
    await ref.set({
      to: payload.to,
      message: payload.body,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    logger.info('SMS enqueued to dispatch collection', {
      to: payload.to,
      docId: ref.id,
      collection: SMS_DISPATCH_COLLECTION,
    });
    return true;
  } catch (error: unknown) {
    logger.error('SMS dispatch write failed', {
      to: payload.to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
```

### What "success" means

`sendSmsNotification` returns `true` when the Firestore document is written (SMS handed to the extension's queue). It does NOT wait for the extension to confirm actual delivery — the same contract as `sendEmailNotification` (returns `true` when SendGrid accepts, not when email is read).

If the MSG91 extension fails to deliver (invalid phone, MSG91 API error), the extension updates the `sms_dispatch` document with an error status. Operators can query: `db.collection('sms_dispatch').where('status', '==', 'ERROR')`.

### Error handling

- Returns `false` on Firestore write failure.
- The outbox worker's `dispatchChannels` re-throws when all channels fail — this drives retry.
- No throw from `sendSmsNotification`: outbox handles retries; inline throws would double-count.

### Retry semantics

Handled by the outbox worker (`processNotificationsOutbox.ts`):
- Default `maxRetries = 5` (`OUTBOX_DEFAULT_MAX_RETRIES`).
- Exponential backoff via `computeBackoffMs(retries)`.
- After 5 failures the row moves to `dead-letter` for operator triage.
- `sendSmsNotification` makes a single Firestore write attempt per worker invocation. Each attempt creates a new doc ID (idempotency note: duplicate docs in `sms_dispatch` on retry are safe — each triggers one SMS send).

### Dead-letter behavior

**Outbox level:** Dead-letter rows in `notifications_outbox` indicate the Firestore write to `sms_dispatch` itself failed (rare). Query: `db.collection('notifications_outbox').where('status', '==', 'dead-letter')`.

**Extension level:** Failed SMS deliveries tracked in `sms_dispatch` documents with `status: 'ERROR'`. Independent of outbox dead-letter.

### Required setup (operator, one-time)

1. `firebase ext:install msg91/msg91-send-msg --project glamornate-758c6`
2. During install prompt, configure:
   - **MSG91 Auth Key** — from MSG91 dashboard (Settings > API Keys)
   - **Collection name** — `sms_dispatch`
   - **Sender ID** — 6-char registered DLT sender (e.g., `GLAMRN`)
3. Add to `backend/functions/.env.example`:
   ```
   MSG91_COLLECTION_NAME=sms_dispatch
   ```

### No new npm dependencies

`sendSmsNotification` uses only `firebase-admin` (already in `package.json`). The extension itself runs in its own Cloud Function namespace and has its own dependencies — invisible to the backend functions bundle.

### Cost notes (MSG91, India)

| Route | Cost per SMS |
|---|---|
| Transactional (booking alerts) | ~0.16-0.25 INR (~$0.002-0.003 USD) |
| Promotional | ~0.10-0.20 INR (~$0.001-0.002 USD) |

Budget estimate: 1000 SMS/month = ~200 INR ($2.40 USD). Significantly cheaper than Twilio or AWS SNS for Indian routes.

---

## Section 5 — Dispatch Contract for `processNotificationsOutbox.ts` SMS Branch

### Fields read from `entry.payload.data`

| Field | Type | Source | Required |
|---|---|---|---|
| `smsTo` | `string` | `context.sms.to` via `enqueueNotificationFromContext` | YES — skip if missing |
| `smsBody` | `string` | `context.sms.body` via `enqueueNotificationFromContext` | YES — skip if missing |
| `smsTemplateId` | `string` | Reserved for future MSG91 template system | NO — not used in Phase 1 |

### SMS branch implementation in `dispatchChannels`

```typescript
if (entry.channels.includes('sms')) {
  const smsTo = entry.payload.data?.smsTo;
  const smsBody = entry.payload.data?.smsBody;
  if (smsTo && smsBody) {
    const ok = await sendSmsNotification({ to: smsTo, body: smsBody }).catch((err) => {
      logger.warn('SMS dispatch threw', {
        userId: entry.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    });
    results.push({ channel: 'sms', ok });
  } else {
    logger.warn('SMS channel requested but smsTo/smsBody missing — skipping', {
      userId: entry.userId,
      type: entry.type,
    });
    // Do NOT push to results — treat as if channel was not requested.
    // Avoids poisoning the anySucceeded check for a misconfigured row.
  }
}
```

### `results[]` success/failure surface

- `{ channel: 'sms', ok: true }` — Firestore doc written to `sms_dispatch` (extension will deliver).
- `{ channel: 'sms', ok: false }` — Firestore write failed; outbox worker retries if no other channel succeeded.
- Missing from results (skip on bad data) — row not penalized; FCM/email outcomes determine retry/deliver.

---

## Section 6 — Producer Call Sites

### Decision matrix

| File | Line | Event | Recipient | SMS needed? | Decision |
|---|---|---|---|---|---|
| `onBookingStatusChanged.ts` | ~253 | `handleConfirmed` — notify spa staff | Spa staff | **NO** | `sms: false` — staff phone numbers not in user schema; no `sms.to` available. |
| `onBookingStatusChanged.ts` | ~308 | `handleEnRoute` — notify customer | Customer | **YES** | `sms: true`, `sms: { to: booking.customer?.phone, body: 'Your Glamornate therapist is on the way! ETA 15-20 minutes.' }` |
| `onBookingStatusChanged.ts` | ~376 | `handleCancelled` — notify customer | Customer | **YES** | `sms: true`, `sms: { to: booking.customer?.phone, body: hasRefund ? 'Your booking was cancelled. Refund of INR {amount} will be processed in 5-7 business days.' : 'Your booking has been cancelled.' }` |
| `onBookingCancelled.ts` | ~80 | Direct Firestore write to `notifications` collection | Customer | **NO** | Keep `sms: false`. Vestigial direct-write — not routed through outbox worker; `channels` map is metadata only, no dispatch occurs. |

### Rationale for en_route = YES

`en_route` is the highest-value SMS use case: the customer needs real-time arrival notice even when the app is backgrounded or uninstalled. FCM alone is unreliable in India where aggressive battery optimization kills background processes. SMS is the reliable fallback.

### Rationale for cancelled = YES

Cancellation with refund details is a financial notification. Customers in India expect SMS confirmation of refund amounts. The FCM-only path risks the message never being seen if the customer has removed the app post-cancellation.

### Rationale for spa staff confirmation = NO

`handleConfirmed` at line ~253 sends to spa staff. Spa staff user documents do not have a standardized `phone` field in the existing schema. Without a reliable `sms.to`, `enqueueNotificationFromContext` would silently drop the SMS channel anyway (line 184 of `notifications-outbox.ts`). Defer to a future phase when staff profiles include verified phone numbers.

### Rationale for onBookingCancelled.ts = NO (vestigial)

`onBookingCancelled.ts:80` writes directly to the `notifications` Firestore collection, bypassing `enqueueNotificationFromContext` entirely. This is an older pattern predating the outbox. The `channels` field on this direct write is metadata only — no worker dispatches from the `notifications` collection. Re-enabling SMS here would create duplicate notifications.

---

## Implementation Checklist

### Operator (one-time, before or after deploy)

- [ ] Install MSG91 extension: `firebase ext:install msg91/msg91-send-msg --project glamornate-758c6`
- [ ] Configure: Auth Key, collection = `sms_dispatch`, Sender ID = registered DLT sender
- [ ] Add `MSG91_COLLECTION_NAME=sms_dispatch` to `backend/functions/.env.example`

### sms-engineer (code — no new npm deps)

- [ ] Implement `SmsPayload` interface and `sendSmsNotification` in `notifications.ts` per Section 4.
- [ ] Replace Twilio tombstone at `notifications.ts:9` with: `// SMS via MSG91 Firebase Extension (msg91/msg91-send-msg) — writes to 'sms_dispatch' Firestore collection. See backend/docs/sms-architecture.md`
- [ ] Add `sms` branch to `dispatchChannels` in `processNotificationsOutbox.ts` per Section 5.
- [ ] Unit tests: mock `admin.firestore()` `.collection().doc().set()`, cover success / Firestore throw / missing smsTo / mixed channels.

### backend-engineer (producers)

- [ ] `handleEnRoute` (~line 308): set `channels: { push: true, sms: true, email: false }` and add `sms: { to: booking.customer?.phone, body: 'Your Glamornate therapist is on the way! ETA 15-20 minutes.' }`.
- [ ] `handleCancelled` (~line 376): set `channels: { push: true, email: true, sms: true }` and add `sms: { to: booking.customer?.phone, body: hasRefund ? 'Your booking was cancelled. Refund will be processed.' : 'Your booking has been cancelled.' }`.
- [ ] `handleConfirmed` spa staff (~line 253): keep `sms: false`.
- [ ] `onBookingCancelled.ts:80`: keep `sms: false`.

---

## Section 7 — Decision Review 2026-04-27

> Reviewed by: sms-arch-master (glamornate-master-audit team)
> Evidence basis: `backend/docs/firebase-sms-research.md` (firebase-master, 2026-04-27)

### Decision matrix applied

**Finding from firebase-master:** Firebase has NO inbuilt API for sending arbitrary transactional SMS. The definitive evidence:

| Firebase Surface | Arbitrary SMS? | Evidence |
|---|---|---|
| Phone Auth `signInWithPhoneNumber` | NO — OTP only | Message body is always a verification code. No API parameter for custom text. |
| Identity Platform MFA SMS | NO — 2FA codes only | Sign-in flow feature; message content not customizable. |
| Firebase Admin SDK | NO | No `sendSMS()` method exists in the Admin SDK for any language. `admin.messaging()` is FCM only. |
| FCM REST API | NO — push only | `projects.messages:send` targets device tokens, not phone numbers. Not carrier-network SMS. |
| Firebase Extensions (MSG91) | YES — via MSG91 carrier | Firestore-trigger pattern. Publisher: MSG91. Firebase provides the Extension framework and trigger. |
| Firebase Extensions (Twilio) | YES — via Twilio carrier | Same Firestore-trigger pattern. Publisher: Twilio Labs, not Firebase/Google. |

**Critical finding on "Firebase-native" parity:** No SMS extension on extensions.dev is authored or maintained by Firebase/Google. The `firebase/firestore-send-email` extension (email) is the only messaging extension Firebase maintains — there is no Firebase-maintained SMS extension. MSG91 and Twilio are equally "Firebase-native": both are third-party publishers distributed via the Firebase Extensions Hub.

### Decision: MSG91 CONFIRMED

The existing MSG91 Firebase Extension architecture is confirmed correct. Rationale:

1. Firebase has no inbuilt arbitrary SMS API. The user's constraint "Firebase inbuilt SMS that we have" refers to Firebase Phone Auth OTP — which cannot send custom message text. The Firebase Extension ecosystem is the correct interpretation of "Firebase-native SMS."
2. All SMS-capable Firebase Extensions are third-party. MSG91 and Twilio are peers in Firebase-nativeness.
3. MSG91 is India-focused, handles DLT compliance for Indian routes, and has lower per-SMS cost for Indian numbers (~0.16–0.25 INR vs Twilio's higher India pricing).
4. The user explicitly stated "Not Twilio" — ruling out the only alternative with broader adoption.
5. No security concerns, deprecation signals, or region issues found for MSG91 in firebase-master's research.

No architecture change required.

---

## Section 8 — User-Facing Reality Check

### What is "Firebase inbuilt SMS"?

Firebase (Google's app development platform) has a feature called **Phone Auth** that sends SMS to users' phones. You may have seen this during sign-up — Firebase sends a 6-digit code like "Your verification code is 123456" to verify a phone number.

**That is the only SMS Firebase can send natively.** Firebase Phone Auth can only send that exact type of short verification code. It cannot send messages like "Your therapist is on the way" or "Your booking has been cancelled."

There is no method in any Firebase SDK or Firebase Console feature that sends a custom text message to a phone number. This was verified by exhaustive research across firebase.google.com, Google Cloud docs, the Firebase Admin SDK reference, and the Firebase Extensions marketplace.

### So how does Glamornate send transactional SMS?

The Firebase ecosystem includes an **Extensions Marketplace** (extensions.dev) — add-ons that run inside your Firebase project, installed with a single Firebase CLI command and visible in the Firebase Console alongside other Firebase services.

For SMS, third-party carriers (MSG91, Twilio, Vonage, etc.) have published extensions to this marketplace. Each follows the same pattern Firebase uses for its own "Trigger Email" extension:

1. Backend code writes a document to a Firestore collection (e.g., `{ to: "+919876543210", message: "Your therapist is on the way!" }`).
2. The installed extension detects the new document and sends the SMS via the carrier's service.
3. The document is updated with delivery status.

Glamornate sends SMS using the **MSG91 Firebase Extension** — this is the most Firebase-integrated available path for transactional SMS on Indian routes.

### Why MSG91?

- **Works within Firebase** — installed via Firebase CLI, visible in Firebase Console, triggered by Firestore.
- **Designed for India** — MSG91 is an Indian SMS provider that handles DLT compliance (required for all commercial SMS in India). Booking alerts and cancellation confirmations are its core use case.
- **Cost-effective** — approximately 0.16–0.25 INR per SMS (~$0.002–$0.003 USD). 1,000 SMS/month costs roughly 200 INR ($2.40 USD).
- **Twilio was the only equally-mature alternative** — but it costs more for Indian numbers and was explicitly excluded by the user.

### What one-time action is required?

```
firebase ext:install msg91/msg91-send-msg --project glamornate-758c6
```

During installation, provide:
- **MSG91 Auth Key** — from MSG91 dashboard (Settings > API Keys)
- **Collection name** — `sms_dispatch` (already configured in the backend code)
- **Sender ID** — 6-character registered DLT sender ID (e.g., `GLAMRN`), obtained by completing DLT registration with TRAI via MSG91

After this one-time setup, all SMS notifications flow automatically whenever the backend writes to the `sms_dispatch` Firestore collection.

### Cost summary

| Volume | Estimated Cost (INR) | Estimated Cost (USD) |
|---|---|---|
| 1,000 SMS/month | ~200 INR | ~$2.40 |
| 5,000 SMS/month | ~1,000 INR | ~$12 |
| 10,000 SMS/month | ~2,000 INR | ~$24 |

Glamornate sends SMS only for high-value events (therapist dispatch, cancellations with refund info) — not marketing blasts — so volumes will be moderate.
