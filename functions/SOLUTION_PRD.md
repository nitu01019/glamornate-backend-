# Glamornate Backend — Solution PRD
**Version:** 1.0 | **Date:** 2026-04-09 | **Status:** Ready for Implementation

---

## 1. Root Cause Analysis

### Bug 1 — `booking.customer` never populated (CRITICAL)
**File:** `src/callable/createBookingDraft.ts` lines 196–230

`transaction.set(bookingRef, { ... })` writes the booking document with `userId` only. No `customer` sub-object with `name`, `email`, or `phone` is embedded. Downstream, `src/utils/notifications.ts` line 461 references `booking.customer?.email` and line 499 references `booking.customer?.phone`. At runtime these are `undefined`, causing empty `to:` fields in SendGrid/Twilio calls and silent notification failure. Any code doing `booking.customer.name` (e.g., a future status-change handler) throws `TypeError: Cannot read properties of undefined`.

### Bug 2 — Rating aggregation is non-atomic and duplicated (CRITICAL)
**File:** `src/triggered/updateTherapistRating.ts` lines 24–85

`updateSpaRating` and `updateEntityRating` both execute a read-compute-write pattern (`get()` → compute average → `update()`) outside a transaction. Concurrent reviews can read stale counts, producing incorrect averages (lost update anomaly). Additionally, there is no second trigger file named `onReviewCreated.ts` visible in the directory, but `updateTherapistRating.ts` is an `onCreate` on `reviews/{reviewId}` and handles both spa and therapist ratings in the same function — if a second trigger were added or the index exports were doubled, both would fire and double-write.

### Bug 3 — Duplicate booking triggers (HIGH)
**File:** `src/triggered/sendBookingConfirmations.ts` (onCreate) vs. `src/triggered/sendStatusUpdate.ts` (onUpdate)

`sendBookingConfirmations` fires on every document creation at `draft` status and sends a "Booking Confirmed" push + spa staff notifications. `sendStatusUpdate` fires on every status field change and sends a second "Payment Confirmed!" push when status transitions to `confirmed`. When a booking is created directly with `confirmed` status (e.g., via an admin flow), both triggers may fire in sequence, delivering two different "confirmed" messages to the customer.

### Bug 4 — Notification delivery not guaranteed (HIGH)
**File:** `src/utils/notifications.ts` lines 283–378

`sendMultiChannelNotification` wraps each channel send in a `.catch()` that logs and sets `results.channel = false`. Failures are swallowed — there is no retry, no dead-letter record written to Firestore, and no Cloud Task / Cloud Scheduler retry. A transient SendGrid or Twilio 500 error causes permanent notification loss.

---

## 2. Industry Best Practice

| Problem | How Airbnb / Urban Company solve it |
|---|---|
| Customer data on bookings | Embed a point-in-time snapshot (`customerSnapshot`) at booking creation. Airbnb's SpinalTap CDC propagates mutations, but for booking history the snapshot is canonical — the customer's current name doesn't retroactively change an old booking. |
| Trigger deduplication | Use Cloud Functions event IDs as idempotency keys. Write a Firestore sentinel doc (`notifications_sent/{eventId}`) before acting; skip if it exists. Google Cloud Blog recommends this pattern explicitly for non-idempotent services like email/SMS. |
| Rating atomicity | Use Firestore `runTransaction` with incremental counters (`ratingSum`, `ratingCount`) rather than reading all reviews and recomputing. Firebase documentation shows exactly this pattern for write-time aggregations. Distributed counters are needed above ~1 write/sec. |
| Notification reliability | Write a `notification_queue` Firestore document with status `pending` before dispatching. A separate scheduled Cloud Function retries `pending` docs older than 2 minutes, up to 3 attempts. Failed-after-max-retries docs move to `failed` (dead-letter equivalent). Cloud Functions 2nd-gen also supports native retry with exponential backoff (10s–600s window, 24h max). |

---

## 3. Solution Design

### Fix 1 — Embed `customerSnapshot` at booking creation
**File to change:** `src/callable/createBookingDraft.ts`

Inside `db.runTransaction`, after validating auth, fetch the user document (`db.collection('users').doc(userId).get()`) within the transaction and embed:

```typescript
customerSnapshot: {
  name: userData.displayName || '',
  email: userData.email || '',
  phone: userData.phoneNumber || '',
},
```

Add this to the `transaction.set(bookingRef, { ... })` call. All downstream notification templates in `src/utils/notifications.ts` (lines 461, 499, 518, etc.) that reference `booking.customer?.email/phone` will resolve correctly without any changes to those files.

### Fix 2 — Atomic rating aggregation with incremental counters
**File to change:** `src/triggered/updateTherapistRating.ts`

Replace the read-all-reviews pattern with an atomic transaction using pre-aggregated counter fields:

```typescript
await db.runTransaction(async (tx) => {
  const ref = db.collection('spas').doc(spaId);
  const doc = await tx.get(ref);
  const existing = doc.data()?.ratingAgg ?? { sum: 0, count: 0 };
  const newCount = existing.count + 1;
  const newSum = existing.sum + review.rating;
  tx.update(ref, {
    'ratingAgg.sum': newSum,
    'ratingAgg.count': newCount,
    'rating.overall': Math.round((newSum / newCount) * 10) / 10,
    'rating.count': newCount,
  });
});
```

Same pattern for `therapists` collection. Eliminates O(n) review reads and race conditions entirely.

### Fix 3 — Deduplicate triggers with a Firestore sentinel
**Files to change:** `src/triggered/sendBookingConfirmations.ts`, `src/triggered/sendStatusUpdate.ts`

At the top of each handler, write an idempotency sentinel using the Cloud Functions event ID:

```typescript
const sentinelRef = db.collection('processed_events').doc(context.eventId);
const sentinel = await sentinelRef.get();
if (sentinel.exists) return null; // already processed
await sentinelRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp(), fn: 'sendBookingConfirmations' });
```

Additionally, `sendBookingConfirmations` should only send the "booking created" notification (type `booking_created`), not "confirmed". Reserve `booking_confirmed` to `sendStatusUpdate` when `after.bookingStatus === 'confirmed'`. This eliminates the semantic overlap between the two triggers.

### Fix 4 — Reliable notification delivery via queue + retry
**Files to change:** `src/utils/notifications.ts`, new `src/triggered/retryFailedNotifications.ts`

Before dispatching, write a queue document:

```typescript
const queueRef = await db.collection('notification_queue').add({
  userId, type, channels, payload, status: 'pending',
  attempts: 0, maxAttempts: 3, createdAt: serverTimestamp(),
});
```

On success, update `status: 'delivered'`. On failure (catch block), update `status: 'failed_attempt', attempts: attempts + 1`. A scheduled function (`scheduleReminders.ts` or a new file) runs every 5 minutes, queries `status == 'pending' AND attempts < 3 AND createdAt < now-2min`, and retries. After 3 failures it sets `status: 'dead_letter'` for manual investigation.

---

## 4. Implementation Order

| Priority | Fix | Risk | Effort |
|---|---|---|---|
| 1 | Fix 1: customerSnapshot embed | Trivial — additive field in transaction | 1h |
| 2 | Fix 2: Atomic rating aggregation | Medium — requires data migration of existing spa/therapist docs | 3h |
| 3 | Fix 3: Event deduplication sentinel | Low — purely additive guard | 2h |
| 4 | Fix 4: Notification queue + retry | Medium — new collection, new scheduled function | 4h |

---

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `customerSnapshot` stale on profile update | Low | Low | Snapshot is intentional; use current user doc for live contact lookups if needed |
| Transaction contention on high-volume rating writes | Medium | Medium | Switch to distributed counters (10 shards) if write rate exceeds 1/sec per entity |
| `processed_events` collection grows unbounded | Medium | Low | Add a scheduled cleanup function to delete docs older than 7 days |
| Retry loop double-delivers notifications | Low | High | Guard each retry with idempotency check on `notification_queue` doc ID used as SendGrid/Twilio idempotency key |

---

## 6. Testing Strategy

### Unit Tests (per fix)
- **Fix 1:** Assert `customerSnapshot` exists on booking doc after `createBookingDraft` call; assert fields are non-empty strings.
- **Fix 2:** Simulate concurrent review writes using two parallel transactions; assert final `rating.overall` equals correct average.
- **Fix 3:** Call trigger handler twice with same `context.eventId`; assert notification created only once.
- **Fix 4:** Mock SendGrid to throw 500; assert `notification_queue` doc has `status: 'failed_attempt'` and `attempts: 1`.

### Integration Tests
- Full booking creation flow: verify booking doc has `customerSnapshot`, verify notification doc has non-empty `to` field.
- Review submission flow: submit 3 reviews concurrently; verify `rating.count === 3` and `rating.overall` is arithmetically correct.

### Regression Tests
- Confirm no duplicate "booking confirmed" push notifications reach the customer when a booking is created.
- Confirm no TypeError in Cloud Functions logs after a booking status change to `confirmed`.

---

## Key File Paths

- `src/callable/createBookingDraft.ts` — Fix 1 (embed customerSnapshot)
- `src/triggered/updateTherapistRating.ts` — Fix 2 (atomic aggregation)
- `src/triggered/sendBookingConfirmations.ts` — Fix 3 (dedup sentinel)
- `src/triggered/sendStatusUpdate.ts` — Fix 3 (dedup sentinel, semantic separation)
- `src/utils/notifications.ts` — Fix 4 (notification queue write)
- `src/triggered/retryFailedNotifications.ts` — Fix 4 (new: retry scheduler)

---

## Sources
- [Retry asynchronous functions — Firebase Docs](https://firebase.google.com/docs/functions/retries)
- [Cloud Functions pro tips: Building idempotent functions — Google Cloud Blog](https://cloud.google.com/blog/products/serverless/cloud-functions-pro-tips-building-idempotent-functions)
- [Cloud Functions pro tips: Retries and idempotency in action — Google Cloud Blog](https://cloud.google.com/blog/products/serverless/cloud-functions-pro-tips-retries-and-idempotency-in-action)
- [Transactions and batched writes — Firebase Docs](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Write-time aggregations — Firebase Docs](https://firebase.google.com/docs/firestore/solutions/aggregation)
- [Best practices for Cloud Firestore — Firebase Docs](https://firebase.google.com/docs/firestore/best-practices)
- [Capturing Data Evolution in a Service-Oriented Architecture — Airbnb Engineering](https://medium.com/airbnb-engineering/capturing-data-evolution-in-a-service-oriented-architecture-72f7c643ee6f)
- [How to Implement Idempotent Cloud Functions — OneUptime Blog](https://oneuptime.com/blog/post/2026-02-17-how-to-implement-idempotent-cloud-functions-to-handle-duplicate-event-deliveries/view)
