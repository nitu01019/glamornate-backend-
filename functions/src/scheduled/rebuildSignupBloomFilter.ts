import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { BloomFilter } from '../utils/bloom-filter';
import { createLogger } from '../utils/logger';

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
 * Normalise a phone string into E.164 form. MUST stay byte-for-byte
 * identical to the reader-side `normalisePhone` in
 * `callable/checkSignupAvailability.ts` — any drift breaks the bloom
 * filter's `has()` probe (the writer would store one byte sequence and
 * the reader would query a different one, so legitimate-collision
 * checks would silently fall through to the authoritative Firestore
 * lookup, defeating the optimisation).
 */
function normalisePhone(raw: string): string {
  const trimmed = raw.replace(/\s+/g, '');
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
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

    const expectedItems = Math.max(userCount, MIN_EXPECTED_ITEMS);
    const emailFilter = BloomFilter.create(expectedItems);
    const phoneFilter = BloomFilter.create(expectedItems);

    // Streaming scan, paginated by document snapshot. We deliberately
    // don't `orderBy` on a user-mutable field — the implicit __name__
    // ordering Firestore uses is stable and gives us deterministic pages.
    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    let scanned = 0;
    let emailAdded = 0;
    let phoneAdded = 0;

    while (true) {
      let q = db
        .collection('users')
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
        if (typeof email === 'string' && email.length > 0) {
          // Mirror the callable's normalisation: lowercase + trim.
          emailFilter.add(email.trim().toLowerCase());
          emailAdded++;
        }
        if (typeof phone === 'string' && phone.length > 0) {
          // Apply the SAME `normalisePhone()` shape the reader uses in
          // `callable/checkSignupAvailability.ts`. Without this, a stored
          // phone like "919999912345" (no +) would be inserted raw into
          // the bloom while the reader would probe "+919999912345" — the
          // bloom would always say "definitely not present" and the
          // optimisation would give a false-available result.
          phoneFilter.add(normalisePhone(phone));
          phoneAdded++;
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
    return null;
  });
