import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { BloomFilter } from '../utils/bloom-filter';
import { createLogger } from '../utils/logger';
import { normalisePhone } from '../utils/phone';
import { SignupEmailSchema, SignupPhoneSchema } from '../shared/contracts';

const logger = createLogger('rebuildSignupBloomFilter');

/**
 * Streaming page size for the user scan. Tuned to keep ~1000 docs in
 * flight which is well under the 256 MB memory budget for any plausible
 * user-row shape (~1-2 KB each).
 */
const STREAM_PAGE_SIZE = 1000;

/**
 * Lower bound on the bloom filter's expected-items count. We never size
 * the filter for fewer than this many users — protects us against the
 * cold-start case where the `users` collection has a handful of rows
 * and a comically-undersized filter would yield a useless FPR.
 */
const MIN_EXPECTED_ITEMS = 10_000;

/**
 * Upper bound on the bloom filter's expected-items count.
 *
 * `computeBitSize` for `n` items at 1% FPR uses ~9.585 * n bits, so:
 *   - n =   700_000 → ~6.7 Mbit → ~840 KB raw → ~1.12 MB base64
 *   - n = 1_000_000 → ~9.5 Mbit → ~1.2 MB raw → ~1.6 MB base64
 *
 * Firestore documents max out at 1 MiB. The 700k cap keeps the
 * serialised payload safely under that ceiling for both the email and
 * phone filters; if `users` ever crosses ~700k rows the audit doc's
 * A-4-10 follow-up (split into two `_meta` docs) becomes mandatory.
 */
const MAX_EXPECTED_ITEMS = 700_000;

/**
 * Inner implementation of the bloom rebuild — extracted so it can be
 * driven from unit tests with a mocked `admin.firestore()`. The
 * scheduled trigger below is a thin wrapper that calls into this.
 */
export async function runRebuildSignupBloomFilter(): Promise<{
  scanned: number;
  emailAdded: number;
  phoneAdded: number;
}> {
  const db = admin.firestore();
  const startedAt = Date.now();
  logger.info('rebuildSignupBloomFilter: starting');

  // First pass — count current users so we can size the filters
  // appropriately. The `count()` aggregator is ~free vs streaming.
  let userCount = 0;
  try {
    const countSnap = await db.collection('users').count().get();
    userCount = countSnap.data().count ?? 0;
  } catch (err) {
    logger.warn('count() unavailable; defaulting to MIN_EXPECTED_ITEMS sizing', err);
    userCount = MIN_EXPECTED_ITEMS;
  }

  // A-4-10: clamp expectedItems so the serialised filter stays under
  // Firestore's 1 MiB document ceiling. The MIN floor protects cold
  // starts (FPR), the MAX ceiling protects the write.
  const expectedItems = Math.min(
    Math.max(userCount, MIN_EXPECTED_ITEMS),
    MAX_EXPECTED_ITEMS,
  );
  const emailFilter = BloomFilter.create(expectedItems);
  const phoneFilter = BloomFilter.create(expectedItems);

  // Streaming scan, paginated by document snapshot.
  //
  // A-4-07: explicit `orderBy(__name__)` so pagination's `startAfter`
  // is anchored to a documented ordering. Implicit `__name__` ordering
  // is stable today but not contractual — pinning it removes a quiet
  // failure mode where a future Firestore behaviour change could yield
  // duplicate or skipped pages.
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let scanned = 0;
  let emailAdded = 0;
  let phoneAdded = 0;

  while (true) {
    let q = db
      .collection('users')
      .orderBy(admin.firestore.FieldPath.documentId())
      .select('profile.email', 'profile.phone')
      .limit(STREAM_PAGE_SIZE);
    if (lastDoc) {
      q = q.startAfter(lastDoc);
    }
    const page = await q.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      scanned++;
      const data = doc.data() as {
        profile?: { email?: unknown; phone?: unknown };
      };
      const email = data.profile?.email;
      const phone = data.profile?.phone;
      // A-4-06: only add SCHEMA-VALID values to the bloom. Garbage rows
      // (legacy malformed emails, half-typed phones) waste FPR budget
      // because every false add bumps the bit-fill of the filter and
      // increases the chance of a downstream `has()` collision on a
      // legitimate probe.
      if (typeof email === 'string' && email.length > 0) {
        const parsed = SignupEmailSchema.safeParse(email);
        if (parsed.success) {
          // The schema already lowercased + trimmed via .trim().toLowerCase()
          // transforms; use the canonical output, not the raw input.
          emailFilter.add(parsed.data);
          emailAdded++;
        }
      }
      if (typeof phone === 'string' && phone.length > 0) {
        // SignupPhoneSchema validates E.164 shape; we additionally
        // normalise via the canonical normaliser so the bloom matches
        // the reader's probe (A-4-01).
        if (SignupPhoneSchema.safeParse(phone).success) {
          phoneFilter.add(normalisePhone(phone));
          phoneAdded++;
        }
      }
    }

    if (page.size < STREAM_PAGE_SIZE) break;
    lastDoc = page.docs[page.docs.length - 1];
  }

  await db
    .collection('_meta')
    .doc('signupBloom')
    .set({
      email: emailFilter.serialise(),
      phone: phoneFilter.serialise(),
      userCount: scanned,
      version: admin.firestore.FieldValue.serverTimestamp(),
    });

  const tookMs = Date.now() - startedAt;
  logger.info('rebuildSignupBloomFilter: completed', {
    scanned,
    emailAdded,
    phoneAdded,
    tookMs,
  });
  return { scanned, emailAdded, phoneAdded };
}

/**
 * Daily rebuild of the signup bloom filters at `_meta/signupBloom`.
 *
 * Scans every `users` document, pipes `profile.email` and
 * `profile.phone` into two separate filters, then writes the
 * serialised payloads back atomically.
 *
 * Schedule: 03:00 IST every day. Off-peak from a customer-traffic POV,
 * and well-aligned with the analytics rollup window so we avoid bursty
 * Firestore reads on the same minute as the hourly aggregator.
 *
 * Resource budget:
 *   - timeoutSeconds: 540 (Cloud Functions v1 max). At 1000 reads/sec
 *     that's ~540k user docs in worst case — gives us plenty of headroom.
 *   - memory: '256MB' — we never hold more than the page in memory plus
 *     the bit buffers (12-16 KB each at our scale).
 *   - maxInstances: 1 — single-writer guarantee for the `_meta/signupBloom`
 *     doc. If a previous invocation is still running, the next tick is
 *     dropped on the floor; that's fine because the data is daily-fresh.
 */
export const rebuildSignupBloomFilter = functions
  .runWith({ timeoutSeconds: 540, memory: '256MB', maxInstances: 1 })
  .pubsub.schedule('0 3 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    await runRebuildSignupBloomFilter();
    return null;
  });
