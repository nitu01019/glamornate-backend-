/**
 * reverseGeocode — callable proxy that resolves (lat, lng) → formattedAddress
 * via Google Maps Geocoding API.
 *
 * Phase-4 contract (PHASE_4.md §3.3.1):
 *   - Caller MUST be authenticated.
 *   - Input validated with Zod: { lat ∈ [-90,90], lng ∈ [-180,180] }.
 *   - Per-uid rate limit: 30 req / 60 s (in-memory — doubles as abuse brake).
 *   - Firestore cache (`geocode_cache/{cellId}`) keyed by 4-decimal lat/lng
 *     bucket with a 24 h TTL.
 *   - Google Maps API key is read from Firebase Secret Manager via
 *     `defineSecret('GOOGLE_MAPS_GEOCODING_KEY')`. The key is NEVER:
 *       • logged,
 *       • echoed back to the client in any field,
 *       • included in error messages.
 *   - Pre-key graceful degradation: if the secret is not set, the callable
 *     throws `HttpsError('failed-precondition', 'geocode/not-configured')`
 *     which the client catches and uses to open the manual address form.
 *   - Google `OVER_QUERY_LIMIT` is translated to
 *     `HttpsError('resource-exhausted', 'geocode/quota')`.
 *
 * Response:
 *   { formattedAddress, components, placeId?, cachedAt, source: 'cache' | 'google' }
 *
 * Deployment: `us-central1`, Secret Manager binding, maxInstances=20.
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
import { z } from 'zod';
import { callableOpts } from '../utils/callable-opts';
import { withRateLimit } from '../utils/withRateLimit';
import { createLogger } from '../utils/logger';
import { handleError } from '../utils/error-handler';
import {
  cellIdForCoords,
  readGeocodeCache,
  writeGeocodeCache,
  type GeocodeComponents,
  type GeocodeResult,
} from '../utils/geocode-cache';

const logger = createLogger('reverseGeocode');

// ---------------------------------------------------------------------------
// Secret binding — Firebase Secret Manager.
// ---------------------------------------------------------------------------

/**
 * The Google Maps Geocoding API key. Registered here so Firebase knows to
 * mount the secret at runtime. NEVER read this value at module load time:
 * always read inside the handler via `.value()` to guarantee the runtime
 * has injected the secret.
 */
export const GOOGLE_MAPS_GEOCODING_KEY = defineSecret('GOOGLE_MAPS_GEOCODING_KEY');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ReverseGeocodeSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

export type ReverseGeocodeInput = z.infer<typeof ReverseGeocodeSchema>;

export interface ReverseGeocodeSuccess {
  readonly formattedAddress: string;
  readonly components: GeocodeComponents;
  readonly placeId?: string;
  readonly cachedAt: number;
  readonly source: 'cache' | 'google';
}

// ---------------------------------------------------------------------------
// Rate limit — 30 requests / 60 s per uid (in-memory).
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

interface Bucket {
  count: number;
  resetAt: number;
}

const uidBuckets = new Map<string, Bucket>();

/** Exported for tests — clears the in-memory rate-limit state. */
export function resetReverseGeocodeRateLimit(): void {
  uidBuckets.clear();
}

function checkRateLimit(uid: string, nowMs: number = Date.now()): void {
  const bucket = uidBuckets.get(uid);
  if (!bucket || bucket.resetAt <= nowMs) {
    uidBuckets.set(uid, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS });
    return;
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'geocode/rate-limited',
      { retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)) },
    );
  }
  bucket.count += 1;
}

// ---------------------------------------------------------------------------
// Google response types
// ---------------------------------------------------------------------------

interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GoogleGeocodeResult {
  address_components?: GoogleAddressComponent[];
  formatted_address?: string;
  place_id?: string;
}

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results?: GoogleGeocodeResult[];
}

// ---------------------------------------------------------------------------
// Google adapter (fetch is injectable for tests)
// ---------------------------------------------------------------------------

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function componentsFromGoogle(
  comps: GoogleAddressComponent[] | undefined,
): GeocodeComponents {
  if (!comps) return {};

  const byType = (type: string): string | undefined =>
    comps.find((c) => c.types.includes(type))?.long_name;

  const line1Parts: string[] = [];
  const subpremise = byType('subpremise');
  const premise = byType('premise');
  const streetNumber = byType('street_number');
  const route = byType('route');
  const neighborhood = byType('neighborhood');
  const sublocality = byType('sublocality') ?? byType('sublocality_level_1');

  if (subpremise) line1Parts.push(subpremise);
  if (premise) line1Parts.push(premise);
  if (streetNumber || route) {
    line1Parts.push([streetNumber, route].filter(Boolean).join(' ').trim());
  } else if (neighborhood) {
    line1Parts.push(neighborhood);
  } else if (sublocality) {
    line1Parts.push(sublocality);
  }

  const city =
    byType('locality') ??
    byType('administrative_area_level_2') ??
    byType('postal_town') ??
    sublocality;
  const state = byType('administrative_area_level_1');
  const pincode = byType('postal_code');
  const country = byType('country');

  const out: GeocodeComponents = {};
  const line1 = line1Parts.filter(Boolean).join(', ').trim();
  if (line1.length > 0) (out as { line1?: string }).line1 = line1;
  if (city) (out as { city?: string }).city = city;
  if (state) (out as { state?: string }).state = state;
  if (pincode) (out as { pincode?: string }).pincode = pincode;
  if (country) (out as { country?: string }).country = country;
  return out;
}

/**
 * Call Google Maps Geocoding API. The API key is treated as strictly
 * secret — it is attached to the request URL (required by Google) but
 * NEVER surfaced in logs, error messages, or the response.
 *
 * Throws `HttpsError` with the appropriate code so callers don't have to
 * branch on provider quirks.
 */
export async function callGoogleGeocode(
  lat: number,
  lng: number,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<GeocodeResult> {
  // Build URL with the key. Deliberately constructed via URLSearchParams to
  // avoid any accidental query injection — the key goes through `append`
  // which URL-encodes it.
  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    language: 'en',
    region: 'in',
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url);
  } catch {
    // DO NOT include the original error in the message — it could contain
    // the URL with the key in its `cause` chain on some runtimes.
    throw new functions.https.HttpsError(
      'unavailable',
      'geocode/upstream-unreachable',
    );
  }

  if (!res.ok) {
    throw new functions.https.HttpsError(
      'unavailable',
      'geocode/upstream-error',
      { httpStatus: res.status },
    );
  }

  let body: GoogleGeocodeResponse;
  try {
    body = (await res.json()) as GoogleGeocodeResponse;
  } catch {
    throw new functions.https.HttpsError('internal', 'geocode/invalid-response');
  }

  switch (body.status) {
    case 'OK':
      break;
    case 'ZERO_RESULTS':
      throw new functions.https.HttpsError(
        'not-found',
        'Could not find your location. Please try a more specific address.',
      );
    case 'OVER_QUERY_LIMIT':
    case 'OVER_DAILY_LIMIT':
      throw new functions.https.HttpsError('resource-exhausted', 'geocode/quota');
    case 'REQUEST_DENIED':
      // Most common cause: key restriction mismatch or API disabled.
      // We do NOT echo Google's error_message since it can contain key hints.
      throw new functions.https.HttpsError(
        'failed-precondition',
        'geocode/request-denied',
      );
    case 'INVALID_REQUEST':
      throw new functions.https.HttpsError(
        'invalid-argument',
        'geocode/invalid-request',
      );
    default:
      throw new functions.https.HttpsError('internal', 'geocode/unknown-status');
  }

  const first = body.results?.[0];
  if (!first || !first.formatted_address) {
    throw new functions.https.HttpsError(
        'not-found',
        'Could not find your location. Please try a more specific address.',
      );
  }

  const result: GeocodeResult = {
    formattedAddress: first.formatted_address,
    components: componentsFromGoogle(first.address_components),
    ...(first.place_id ? { placeId: first.place_id } : {}),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Default fetch
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = async (url) => {
  // Node 20 on Cloud Functions has global `fetch`.
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
  };
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handler body — exposed so tests can invoke it directly with injected
 * dependencies (admin.firestore instance, fetch impl, clock).
 */
export async function reverseGeocodeHandler(
  data: unknown,
  context: functions.https.CallableContext,
  deps: {
    db: admin.firestore.Firestore;
    fetchImpl?: FetchLike;
    getSecret: () => string | undefined;
    nowMs?: () => number;
  },
): Promise<ReverseGeocodeSuccess> {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'auth/required');
  }

  const uid = context.auth.uid;
  const now = deps.nowMs ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? defaultFetch;

  let input: ReverseGeocodeInput;
  try {
    input = ReverseGeocodeSchema.parse(data);
  } catch (err) {
    throw handleError(err);
  }

  checkRateLimit(uid, now());

  const cellId = cellIdForCoords(input.lat, input.lng);

  // ---- 1. Firestore cache lookup -----------------------------------------
  const cached = await readGeocodeCache(deps.db, cellId, now());
  if (cached) {
    logger.info('cache hit', { uid, cellId });
    return {
      formattedAddress: cached.formattedAddress,
      components: cached.components,
      ...(cached.placeId ? { placeId: cached.placeId } : {}),
      cachedAt: cached.cachedAt,
      source: 'cache',
    };
  }

  // ---- 2. Secret check ---------------------------------------------------
  // Reject empty AND the bootstrap placeholder string up-front. Sending the
  // placeholder to Google returns REQUEST_DENIED, which is indistinguishable
  // from a real bad-key event at the client — so we short-circuit here so
  // the UI shows the right "set up your key" copy.
  const apiKey = deps.getSecret();
  const isPlaceholder = typeof apiKey === 'string' && apiKey.startsWith('PLACEHOLDER_');
  if (!apiKey || apiKey.trim().length === 0 || isPlaceholder) {
    logger.warn('geocode/not-configured — GOOGLE_MAPS_GEOCODING_KEY not set', {
      uid,
      cellId,
      placeholder: isPlaceholder,
    });
    throw new functions.https.HttpsError(
      'failed-precondition',
      'geocode/not-configured',
    );
  }

  // ---- 3. Upstream call --------------------------------------------------
  const result = await callGoogleGeocode(input.lat, input.lng, apiKey, fetchImpl);

  // ---- 4. Cache-and-return ----------------------------------------------
  const cachedAt = now();
  await writeGeocodeCache(deps.db, cellId, input.lat, input.lng, result, cachedAt);

  // IMPORTANT: Only `uid` and `cellId` hit the logs — never the key, the URL,
  // or Google's raw response.
  logger.info('geocode resolved via google', { uid, cellId });

  return {
    formattedAddress: result.formattedAddress,
    components: result.components,
    ...(result.placeId ? { placeId: result.placeId } : {}),
    cachedAt,
    source: 'google',
  };
}

// ---------------------------------------------------------------------------
// Exported callable
// ---------------------------------------------------------------------------

export const reverseGeocode = callableOpts({
    secrets: [GOOGLE_MAPS_GEOCODING_KEY],
    maxInstances: 20,
    timeoutSeconds: 30,
    memory: '256MB',
    region: 'us-central1',
  })
  .https.onCall(
    withRateLimit<unknown, ReverseGeocodeSuccess>(
      { name: 'reverseGeocode', windowMs: 60_000, max: 20 },
      async (data, context): Promise<ReverseGeocodeSuccess> => {
    try {
      return await reverseGeocodeHandler(data, context, {
        db: admin.firestore(),
        getSecret: () => {
          try {
            return GOOGLE_MAPS_GEOCODING_KEY.value();
          } catch {
            // `.value()` throws if the secret is not bound to the runtime —
            // treat that identically to an empty value.
            return undefined;
          }
        },
      });
    } catch (err) {
      if (err instanceof functions.https.HttpsError) {
        throw err;
      }
      throw handleError(err);
    }
  },
    ),
  );
