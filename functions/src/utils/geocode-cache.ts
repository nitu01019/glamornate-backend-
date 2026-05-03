/**
 * Firestore-backed cache for reverse-geocoded coordinates.
 *
 * Goals:
 *   - Zero client reads — only Cloud Functions (Admin SDK) touch this collection.
 *   - 24-hour TTL per cell so we don't pay Google twice for the same neighborhood.
 *   - Deterministic cache key derived from lat/lng rounded to 4 decimals
 *     (~11 m grid), cheap to compute and collision-safe for end-user zoom levels.
 *
 * Phase-4 §3.3.1: cache key mirrors what the PHASE_4 plan calls
 * `h3_r10(lat, lng)`. We implement the simpler (lat4, lng4) bucket here — it
 * lands in the same 10-m neighborhood and avoids pulling in the `h3-js`
 * dependency for the first release. If/when Google usage explodes we can
 * swap the key strategy without changing the callable's shape.
 */

import * as admin from 'firebase-admin';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeocodeComponents {
  readonly line1?: string;
  readonly city?: string;
  readonly state?: string;
  readonly pincode?: string;
  readonly country?: string;
}

export interface GeocodeResult {
  readonly formattedAddress: string;
  readonly components: GeocodeComponents;
  readonly placeId?: string;
}

export interface CachedGeocodeDoc extends GeocodeResult {
  readonly cachedAt: number; // epoch ms
  readonly lat: number;
  readonly lng: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Firestore collection name — deliberately namespaced with an underscore so
 *  rules can block all client access with a single match. */
export const GEOCODE_CACHE_COLLECTION = 'geocode_cache';

/** 24 hours in ms. Fresh cache entries older than this are ignored. */
export const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Build the cache key for a coordinate.
 *
 * Rounds lat/lng to 4 decimals, which groups coordinates inside roughly an
 * 11-m × 11-m tile at Indian latitudes. Negative numbers are encoded as `n`
 * (lat) / `w` (lng) so the document id stays strictly `[a-z0-9_]` and is
 * safe to use as a Firestore doc id without escaping.
 *
 * Example: (12.9716, 77.5946) → "s12_9716_e77_5946"
 */
export function cellIdForCoords(lat: number, lng: number): string {
  const latRound = Math.round(lat * 10000) / 10000;
  const lngRound = Math.round(lng * 10000) / 10000;

  const latSign = latRound >= 0 ? 's' : 'n';
  const lngSign = lngRound >= 0 ? 'e' : 'w';

  const latMagnitude = Math.abs(latRound).toFixed(4).replace('.', '_');
  const lngMagnitude = Math.abs(lngRound).toFixed(4).replace('.', '_');

  return `${latSign}${latMagnitude}_${lngSign}${lngMagnitude}`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read a fresh (< 24 h) cached geocode. Returns `null` on miss, stale hit,
 * or any Firestore error — the caller should treat a miss as authoritative
 * and fall through to the upstream provider.
 */
export async function readGeocodeCache(
  db: admin.firestore.Firestore,
  cellId: string,
  nowMs: number = Date.now(),
): Promise<CachedGeocodeDoc | null> {
  try {
    const snap = await db.collection(GEOCODE_CACHE_COLLECTION).doc(cellId).get();
    if (!snap.exists) return null;

    const data = snap.data() as Partial<CachedGeocodeDoc> | undefined;
    if (!data || typeof data.cachedAt !== 'number') return null;

    if (nowMs - data.cachedAt > GEOCODE_CACHE_TTL_MS) return null;
    if (typeof data.formattedAddress !== 'string') return null;

    return {
      formattedAddress: data.formattedAddress,
      components: data.components ?? {},
      placeId: data.placeId,
      cachedAt: data.cachedAt,
      lat: typeof data.lat === 'number' ? data.lat : 0,
      lng: typeof data.lng === 'number' ? data.lng : 0,
    };
  } catch {
    // Cache is best-effort. Surface a miss so the caller decides what to do.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist a geocode result. Best-effort — a cache write that fails should
 * not fail the callable, the user still gets their address.
 */
export async function writeGeocodeCache(
  db: admin.firestore.Firestore,
  cellId: string,
  lat: number,
  lng: number,
  result: GeocodeResult,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const doc: CachedGeocodeDoc = {
      formattedAddress: result.formattedAddress,
      components: result.components,
      ...(result.placeId ? { placeId: result.placeId } : {}),
      cachedAt: nowMs,
      lat,
      lng,
    };
    await db.collection(GEOCODE_CACHE_COLLECTION).doc(cellId).set(doc);
  } catch {
    // Swallow — cache write failure must not affect the response.
  }
}
