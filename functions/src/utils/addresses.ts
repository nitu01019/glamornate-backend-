import * as admin from 'firebase-admin';
import { z } from 'zod';
import { createLogger } from './logger';

const logger = createLogger('addresses');

/**
 * Phase 4 / 4A — shared helpers for the `users/{uid}/addresses/{addressId}`
 * subcollection CRUD + migration.
 *
 * Design goals:
 *   - Every write path runs inside a Firestore transaction so the
 *     "exactly one default" invariant is enforced even under concurrent
 *     add / update / delete race conditions.
 *   - The migration from the legacy `users/{uid}.addresses[]` inline array
 *     to the new subcollection is strictly two-phase: subcollection writes
 *     FIRST, array-clear SECOND. If the second phase fails we still have
 *     both copies and a subsequent call can resume without data loss.
 *   - All writes preserve `createdAt` (when migrating) and set
 *     `updatedAt` via server timestamp.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum addresses a single user can store. */
export const MAX_ADDRESSES_PER_USER = 20;

/** Firestore batch limit is 500; we leave headroom for the parent doc. */
export const MIGRATION_BATCH_SIZE = 450;

/**
 * Path helpers — centralised so tests, migration, and cascade-delete all
 * agree on the same paths.
 */
export const addressPaths = {
  userDoc: (uid: string): string => `users/${uid}`,
  subcollection: (uid: string): string => `users/${uid}/addresses`,
  address: (uid: string, addressId: string): string =>
    `users/${uid}/addresses/${addressId}`,
  migrationJournal: (uid: string): string => `address_migrations/${uid}`,
};

// ---------------------------------------------------------------------------
// Zod schemas (shared between callables)
// ---------------------------------------------------------------------------

/** E.164-friendly phone — digits + optional leading + and whitespace/dash. */
const PhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^[+\d][\d\s\-()]{5,19}$/, 'Invalid phone number');

const PincodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,10}$/, 'Invalid pincode');

export const AddressLabelSchema = z.enum(['home', 'work', 'other']);

export const GeoSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().positive().optional(),
  })
  .optional();

/**
 * Full address shape. Matches the frontend `SavedAddress` type in
 * `frontend/src/types/index.ts` (minus server-managed fields).
 *
 * The consumer contract for Alpha's Phase 2 is defined in `addAddress.ts`.
 */
export const AddressInputSchema = z.object({
  label: AddressLabelSchema,
  name: z.string().trim().min(1).max(80),
  phone: PhoneSchema,
  flatHouse: z.string().trim().min(1).max(120),
  street: z.string().trim().min(1).max(200),
  landmark: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  pincode: PincodeSchema,
  isDefault: z.boolean().optional(),
  geo: GeoSchema,
});

export type AddressInput = z.infer<typeof AddressInputSchema>;

/** Patch schema — every field optional, isDefault explicitly omitted. */
export const AddressPatchSchema = AddressInputSchema.omit({
  isDefault: true,
}).partial();

export type AddressPatch = z.infer<typeof AddressPatchSchema>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type FirestoreTx = FirebaseFirestore.Transaction;
type FirestoreDb = FirebaseFirestore.Firestore;

// ---------------------------------------------------------------------------
// Invariant helper
// ---------------------------------------------------------------------------

/**
 * Within a transaction, demote every other address so only `keepDefaultId`
 * (if provided) remains `isDefault: true`. If `keepDefaultId` is null
 * and `promoteFallback` is true, promote the most-recently-updated
 * remaining address to default.
 *
 * Returns the id of whichever address is now the default (or null if the
 * user has zero addresses after this operation).
 */
export async function ensureSingleDefault(
  tx: FirestoreTx,
  db: FirestoreDb,
  uid: string,
  keepDefaultId: string | null,
  opts: { promoteFallback?: boolean } = {},
): Promise<string | null> {
  const subcolRef = db.collection(addressPaths.subcollection(uid));
  const snap = await tx.get(subcolRef);

  const docs = snap.docs;
  if (docs.length === 0) {
    return null;
  }

  // Determine who should be the default.
  let chosenId: string | null = keepDefaultId;
  if (!chosenId && opts.promoteFallback) {
    // Pick the address with the latest updatedAt (fall back to createdAt
    // then to document id for total ordering).
    const sorted = [...docs].sort((a, b) => {
      const ad = a.data() as Record<string, unknown>;
      const bd = b.data() as Record<string, unknown>;
      const atime = readMillis(ad.updatedAt) ?? readMillis(ad.createdAt) ?? 0;
      const btime = readMillis(bd.updatedAt) ?? readMillis(bd.createdAt) ?? 0;
      if (atime !== btime) return btime - atime;
      return (a.id > b.id ? -1 : 1);
    });
    chosenId = sorted[0]?.id ?? null;
  }

  const nowServer = admin.firestore.FieldValue.serverTimestamp();

  for (const doc of docs) {
    const currentData = doc.data() as Record<string, unknown>;
    const currentlyDefault = currentData.isDefault === true;
    const shouldBeDefault = chosenId !== null && doc.id === chosenId;
    if (currentlyDefault !== shouldBeDefault) {
      tx.update(doc.ref, {
        isDefault: shouldBeDefault,
        updatedAt: nowServer,
      });
    }
  }

  return chosenId;
}

/**
 * Read the numeric millis from a Firestore Timestamp / JS Date /
 * ISO-string. Returns null if none of those match — used for "best-effort"
 * sort keys.
 */
function readMillis(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as { toMillis?: () => number; seconds?: number };
    if (typeof obj.toMillis === 'function') return obj.toMillis();
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return null;
}

/**
 * Update `users/{uid}.defaultAddressId` + `addressCount` inside the same
 * transaction as the address write. Safe to call even if the user doc
 * doesn't exist yet (it will be created).
 */
export function writeUserAddressSummary(
  tx: FirestoreTx,
  db: FirestoreDb,
  uid: string,
  defaultAddressId: string | null,
  addressCount: number,
): void {
  const userRef = db.collection('users').doc(uid);
  tx.set(
    userRef,
    {
      defaultAddressId,
      addressCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ---------------------------------------------------------------------------
// Booking reference guard (for deleteAddress)
// ---------------------------------------------------------------------------

/**
 * Active booking statuses that hold an address reference and therefore
 * block deletion of that address. See `BookingStatus` in the frontend
 * types — these are the pre-terminal states.
 */
const ACTIVE_BOOKING_STATUSES = [
  'draft',
  'payment_pending',
  'confirmed',
  'en_route',
  'in_service',
  'in_progress',
] as const;

/**
 * Returns true if the user has an active (non-terminal) booking that
 * references the given addressId. The query intentionally uses `in`
 * on a small set (≤10 values allowed by Firestore) combined with an
 * `addressId` equality filter — NOT a collection-group scan.
 *
 * If the schema has not yet added `addressId` to bookings (Phase 4
 * frontend hasn't shipped), this returns false — future-proof.
 */
export async function hasActiveBookingReferencingAddress(
  db: FirestoreDb,
  uid: string,
  addressId: string,
): Promise<boolean> {
  try {
    const snap = await db
      .collection('bookings')
      .where('userId', '==', uid)
      .where('addressId', '==', addressId)
      .where('bookingStatus', 'in', [...ACTIVE_BOOKING_STATUSES])
      .limit(1)
      .get();
    return !snap.empty;
  } catch (error) {
    // Missing index or field → treat as "no blocking booking" rather than
    // failing the user's delete request. Log so ops can add the index.
    logger.warn('hasActiveBookingReferencingAddress — query failed, allowing delete', {
      uid,
      addressId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Migration (idempotent, two-phase)
// ---------------------------------------------------------------------------

export interface MigrationResult {
  migrated: number;
  alreadyDone: boolean;
}

/**
 * Migrate the legacy `users/{uid}.addresses[]` inline array to the new
 * `users/{uid}/addresses/{addressId}` subcollection.
 *
 * Two-phase + idempotent:
 *   Phase A: write every legacy entry to the subcollection (merge-safe)
 *            and mark the migration journal `phaseA: true`.
 *   Phase B: clear the inline array from the user document (and mark
 *            `phaseB: true`). Second invocations short-circuit when
 *            phaseB is already set.
 *
 * If Phase A completed but Phase B crashed, a subsequent call finishes
 * Phase B without re-writing the subcollection.
 *
 * NOTE: We preserve the original `id` from the inline entry as the
 * subcollection document id so any dangling client-side references (e.g.
 * `customerData.defaultAddressId`) keep resolving.
 */
export async function migrateOne(
  uid: string,
  dbInput?: FirestoreDb,
): Promise<MigrationResult> {
  const db = dbInput ?? admin.firestore();
  const journalRef = db.doc(addressPaths.migrationJournal(uid));
  const journalSnap = await journalRef.get();
  const journal = (journalSnap.exists ? journalSnap.data() : undefined) as
    | { phaseA?: boolean; phaseB?: boolean; migrated?: number }
    | undefined;

  if (journal?.phaseB === true) {
    return {
      migrated: typeof journal.migrated === 'number' ? journal.migrated : 0,
      alreadyDone: true,
    };
  }

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? (userSnap.data() ?? {}) : null;
  if (!userData) {
    // No user doc → nothing to migrate. Mark done so we don't loop.
    await journalRef.set(
      {
        phaseA: true,
        phaseB: true,
        migrated: 0,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { migrated: 0, alreadyDone: false };
  }

  const legacy = Array.isArray(userData.addresses)
    ? (userData.addresses as Array<Record<string, unknown>>)
    : [];

  // -------- Phase A: write subcollection docs (idempotent via merge) -------
  if (!journal?.phaseA) {
    await journalRef.set(
      {
        phaseA: false,
        phaseB: false,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (legacy.length > 0) {
      // Normalize: ensure exactly one default. If the legacy array had
      // multiple defaults, keep the first; if none, promote the first.
      const normalized = normaliseLegacyAddresses(legacy);

      // Write in chunks to respect the batch limit.
      for (let i = 0; i < normalized.length; i += MIGRATION_BATCH_SIZE) {
        const chunk = normalized.slice(i, i + MIGRATION_BATCH_SIZE);
        const batch = db.batch();
        for (const entry of chunk) {
          const docRef = db.doc(addressPaths.address(uid, entry.id));
          batch.set(
            docRef,
            {
              ...entry,
              migratedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
        await batch.commit();
      }
    }

    await journalRef.set(
      {
        phaseA: true,
        migrated: legacy.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  // -------- Phase B: update user-doc summary + clear inline array ---------
  const normalized = normaliseLegacyAddresses(legacy);
  const defaultEntry = normalized.find((a) => a.isDefault === true);

  await userRef.set(
    {
      addresses: admin.firestore.FieldValue.delete(),
      defaultAddressId: defaultEntry?.id ?? null,
      addressCount: normalized.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await journalRef.set(
    {
      phaseB: true,
      migrated: normalized.length,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logger.info('Address migration complete', {
    uid,
    migrated: normalized.length,
  });

  return { migrated: normalized.length, alreadyDone: false };
}

/**
 * Normalise a legacy inline-array entry to a subcollection doc:
 *   - preserve id (fallback: generate)
 *   - enforce exactly one default (first wins; promote first if none)
 *   - pass through known fields, drop unknown
 */
interface NormalisedAddress {
  id: string;
  label: 'home' | 'work' | 'other';
  name: string;
  phone: string;
  flatHouse: string;
  street: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
  createdAt: unknown;
  updatedAt: unknown;
  geo?: { lat: number; lng: number; accuracy?: number };
}

function normaliseLegacyAddresses(
  legacy: Array<Record<string, unknown>>,
): NormalisedAddress[] {
  if (legacy.length === 0) return [];

  const out: NormalisedAddress[] = legacy.map((entry, idx) => {
    const rawLabel = typeof entry.label === 'string' ? entry.label : 'other';
    const label = (['home', 'work', 'other'] as const).includes(
      rawLabel as never,
    )
      ? (rawLabel as 'home' | 'work' | 'other')
      : 'other';

    const now = new Date().toISOString();
    const id =
      typeof entry.id === 'string' && entry.id.length > 0
        ? entry.id
        : `migrated_${Date.now()}_${idx}`;

    const result: NormalisedAddress = {
      id,
      label,
      name: String(entry.name ?? ''),
      phone: String(entry.phone ?? ''),
      flatHouse: String(entry.flatHouse ?? ''),
      street: String(entry.street ?? ''),
      landmark:
        typeof entry.landmark === 'string' && entry.landmark.length > 0
          ? entry.landmark
          : undefined,
      city: String(entry.city ?? ''),
      state: String(entry.state ?? ''),
      pincode: String(entry.pincode ?? ''),
      isDefault: entry.isDefault === true,
      createdAt: entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
      geo: isGeo(entry.geo) ? entry.geo : undefined,
    };
    return result;
  });

  // Enforce exactly one default.
  const defaultCount = out.filter((a) => a.isDefault).length;
  if (defaultCount > 1) {
    let kept = false;
    for (const addr of out) {
      if (addr.isDefault && !kept) {
        kept = true;
      } else {
        addr.isDefault = false;
      }
    }
  } else if (defaultCount === 0 && out.length > 0) {
    out[0].isDefault = true;
  }

  return out;
}

function isGeo(v: unknown): v is { lat: number; lng: number; accuracy?: number } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.lat === 'number' && typeof o.lng === 'number';
}

// ---------------------------------------------------------------------------
// Utility: generate a stable auto-id without hitting the server. Mirrors
// the shape we'd get from `db.collection(...).doc().id` but usable inside
// transactions where we create the ref ahead of time.
// ---------------------------------------------------------------------------

export function newAddressId(db: FirestoreDb, uid: string): string {
  return db.collection(addressPaths.subcollection(uid)).doc().id;
}
