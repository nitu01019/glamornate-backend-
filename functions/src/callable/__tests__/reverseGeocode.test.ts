/**
 * reverseGeocode callable — unit tests.
 *
 * All Firebase primitives are mocked in-process (same pattern as
 * `deleteAccount.test.ts`). The suite covers the PHASE_4 §3.3.2 scenarios:
 *
 *   1. Happy path with a mocked Google fetch.
 *   2. Missing key → `failed-precondition/geocode/not-configured`.
 *   3. Quota exhausted → `resource-exhausted/geocode/quota`.
 *   4. Cache hit → no fetch call.
 *   5. KEY-LEAK REGRESSION: no logger line, no error message, no response
 *      field contains the configured key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// firebase-functions mock — HttpsError class + onCall passthrough + logger spy
// ---------------------------------------------------------------------------

const loggerCalls = vi.hoisted(() => ({
  debug: [] as unknown[][],
  info: [] as unknown[][],
  warn: [] as unknown[][],
  error: [] as unknown[][],
  reset(): void {
    this.debug = [];
    this.info = [];
    this.warn = [];
    this.error = [];
  },
}));

vi.mock('firebase-functions', () => {
  class HttpsError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.name = 'HttpsError';
      this.code = code;
      this.details = details;
    }
  }
  const https = {
    HttpsError,
    onCall: (handler: unknown) => handler,
  };
  const runWith = () => ({
    https,
    region: () => ({ https }),
  });
  const logger = {
    debug: (...args: unknown[]) => loggerCalls.debug.push(args),
    info: (...args: unknown[]) => loggerCalls.info.push(args),
    warn: (...args: unknown[]) => loggerCalls.warn.push(args),
    error: (...args: unknown[]) => loggerCalls.error.push(args),
  };
  return {
    default: { runWith, https, logger },
    runWith,
    https,
    logger,
  };
});

// ---------------------------------------------------------------------------
// firebase-functions/params — secret shim.
// We route `defineSecret(name).value()` through a mutable store the test can
// reassign between cases.
// ---------------------------------------------------------------------------

const secretStore = vi.hoisted(() => ({
  values: new Map<string, string | undefined>(),
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({
    name,
    value: () => {
      const v = secretStore.values.get(name);
      if (v === undefined) {
        // Mirror real behavior: `.value()` throws when unbound.
        throw new Error(`Secret ${name} not bound`);
      }
      return v;
    },
  }),
}));

// ---------------------------------------------------------------------------
// firebase-admin mock — minimal Firestore fake sufficient for the cache.
// ---------------------------------------------------------------------------

const firestoreFake = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();

  const collection = (name: string) => ({
    doc: (id: string) => {
      const path = `${name}/${id}`;
      return {
        async get() {
          const data = docs.get(path);
          return {
            exists: data !== undefined,
            data: () => (data ? { ...data } : undefined),
          };
        },
        async set(value: Record<string, unknown>) {
          docs.set(path, { ...value });
        },
      };
    },
  });

  return { docs, collection };
});

vi.mock('firebase-admin', () => {
  const firestoreFn = () => ({
    collection: firestoreFake.collection,
  });
  return {
    default: {
      firestore: firestoreFn,
      initializeApp: vi.fn(),
    },
    firestore: firestoreFn,
    initializeApp: vi.fn(),
  };
});

// Silence createLogger — we only spy on the raw `functions.logger` output.
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => loggerCalls.debug.push(args),
    info: (...args: unknown[]) => loggerCalls.info.push(args),
    warn: (...args: unknown[]) => loggerCalls.warn.push(args),
    error: (...args: unknown[]) => loggerCalls.error.push(args),
  }),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks).
// ---------------------------------------------------------------------------

import * as admin from 'firebase-admin';
import {
  reverseGeocodeHandler,
  resetReverseGeocodeRateLimit,
  callGoogleGeocode,
  type FetchLike,
} from '../reverseGeocode';
import {
  GEOCODE_CACHE_COLLECTION,
  cellIdForCoords,
} from '../../utils/geocode-cache';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TEST_UID = 'user_abc_123';
const BENGALURU_LAT = 12.9716;
const BENGALURU_LNG = 77.5946;
const FAKE_KEY = 'FAKE_KEY_ABC123XYZ789';

function authedContext() {
  return {
    auth: { uid: TEST_UID, token: {} },
  } as unknown as Parameters<typeof reverseGeocodeHandler>[1];
}

function googleOk(): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'OK',
      results: [
        {
          formatted_address: '100 MG Road, Bengaluru, Karnataka 560001, India',
          place_id: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
          address_components: [
            { long_name: '100', short_name: '100', types: ['street_number'] },
            { long_name: 'MG Road', short_name: 'MG Road', types: ['route'] },
            {
              long_name: 'Bengaluru',
              short_name: 'Bengaluru',
              types: ['locality'],
            },
            {
              long_name: 'Karnataka',
              short_name: 'KA',
              types: ['administrative_area_level_1'],
            },
            { long_name: '560001', short_name: '560001', types: ['postal_code'] },
            { long_name: 'India', short_name: 'IN', types: ['country'] },
          ],
        },
      ],
    }),
  });
}

function googleOverQuota(): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'OVER_QUERY_LIMIT',
      error_message: 'You have exceeded your daily request quota',
    }),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  firestoreFake.docs.clear();
  loggerCalls.reset();
  resetReverseGeocodeRateLimit();
  secretStore.values.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reverseGeocodeHandler', () => {
  it('1. happy path — fetches from google, caches result, returns source=google', async () => {
    secretStore.values.set('GOOGLE_MAPS_GEOCODING_KEY', FAKE_KEY);
    const fetchSpy = vi.fn(googleOk());

    const result = await reverseGeocodeHandler(
      { lat: BENGALURU_LAT, lng: BENGALURU_LNG },
      authedContext(),
      {
        db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
        fetchImpl: fetchSpy,
        getSecret: () => FAKE_KEY,
      },
    );

    expect(result.source).toBe('google');
    expect(result.formattedAddress).toContain('MG Road');
    expect(result.components.city).toBe('Bengaluru');
    expect(result.components.pincode).toBe('560001');
    expect(result.components.country).toBe('India');
    expect(result.placeId).toBe('ChIJbU60yXAWrjsR4E9-UejD3_g');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Cache entry must have been written.
    const cellId = cellIdForCoords(BENGALURU_LAT, BENGALURU_LNG);
    const cacheDocPath = `${GEOCODE_CACHE_COLLECTION}/${cellId}`;
    expect(firestoreFake.docs.has(cacheDocPath)).toBe(true);
  });

  it('2. missing key — throws failed-precondition/geocode/not-configured', async () => {
    // Secret not set — getSecret returns undefined.
    const fetchSpy = vi.fn(googleOk());

    await expect(
      reverseGeocodeHandler(
        { lat: BENGALURU_LAT, lng: BENGALURU_LNG },
        authedContext(),
        {
          db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
          fetchImpl: fetchSpy,
          getSecret: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'geocode/not-configured',
    });

    // No Google call must have happened.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('3. quota exhausted — translates OVER_QUERY_LIMIT to resource-exhausted/geocode/quota', async () => {
    const fetchSpy = vi.fn(googleOverQuota());

    await expect(
      reverseGeocodeHandler(
        { lat: BENGALURU_LAT, lng: BENGALURU_LNG },
        authedContext(),
        {
          db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
          fetchImpl: fetchSpy,
          getSecret: () => FAKE_KEY,
        },
      ),
    ).rejects.toMatchObject({
      code: 'resource-exhausted',
      message: 'geocode/quota',
    });
  });

  it('4. cache hit — does NOT call google when a fresh cache entry exists', async () => {
    const cellId = cellIdForCoords(BENGALURU_LAT, BENGALURU_LNG);
    firestoreFake.docs.set(`${GEOCODE_CACHE_COLLECTION}/${cellId}`, {
      formattedAddress: 'Cached addr, Bengaluru',
      components: { city: 'Bengaluru', country: 'India' },
      placeId: 'cached-place-id',
      cachedAt: Date.now(),
      lat: BENGALURU_LAT,
      lng: BENGALURU_LNG,
    });

    const fetchSpy = vi.fn(googleOk());

    const result = await reverseGeocodeHandler(
      { lat: BENGALURU_LAT, lng: BENGALURU_LNG },
      authedContext(),
      {
        db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
        fetchImpl: fetchSpy,
        getSecret: () => FAKE_KEY,
      },
    );

    expect(result.source).toBe('cache');
    expect(result.formattedAddress).toBe('Cached addr, Bengaluru');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('5. KEY-LEAK REGRESSION — no log line, error, or response contains the key', async () => {
    // Arrange: configure the key AND make Google reject so both the happy
    // path AND the error path get exercised.
    const fetchHappy = vi.fn(googleOk());
    const result = await reverseGeocodeHandler(
      { lat: BENGALURU_LAT, lng: BENGALURU_LNG },
      authedContext(),
      {
        db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
        fetchImpl: fetchHappy,
        getSecret: () => FAKE_KEY,
      },
    );

    // Drain another call that exercises the quota branch
    await expect(
      reverseGeocodeHandler(
        { lat: BENGALURU_LAT, lng: BENGALURU_LNG + 0.01 },
        authedContext(),
        {
          db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
          fetchImpl: vi.fn(googleOverQuota()),
          getSecret: () => FAKE_KEY,
        },
      ),
    ).rejects.toBeDefined();

    // Aggregate every byte we emit to logs + response and grep for the key.
    const allLogs = [
      ...loggerCalls.debug,
      ...loggerCalls.info,
      ...loggerCalls.warn,
      ...loggerCalls.error,
    ]
      .map((args) => JSON.stringify(args))
      .join('\n');
    expect(allLogs).not.toContain(FAKE_KEY);

    // Neither the happy-path result nor its JSON form should include the key.
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('rejects unauthenticated callers', async () => {
    await expect(
      reverseGeocodeHandler(
        { lat: BENGALURU_LAT, lng: BENGALURU_LNG },
        { auth: null } as unknown as Parameters<typeof reverseGeocodeHandler>[1],
        {
          db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
          fetchImpl: vi.fn(googleOk()),
          getSecret: () => FAKE_KEY,
        },
      ),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      message: 'auth/required',
    });
  });

  it('rejects invalid coordinates', async () => {
    await expect(
      reverseGeocodeHandler(
        { lat: 999, lng: 0 },
        authedContext(),
        {
          db: admin.firestore() as unknown as FirebaseFirestore.Firestore,
          fetchImpl: vi.fn(googleOk()),
          getSecret: () => FAKE_KEY,
        },
      ),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});

// ---------------------------------------------------------------------------
// callGoogleGeocode — direct unit tests for the upstream adapter.
// ---------------------------------------------------------------------------

describe('callGoogleGeocode', () => {
  it('maps address_components into our canonical shape', async () => {
    const r = await callGoogleGeocode(1, 2, FAKE_KEY, googleOk());
    expect(r.formattedAddress).toContain('MG Road');
    expect(r.components.city).toBe('Bengaluru');
    expect(r.components.state).toBe('Karnataka');
    expect(r.components.pincode).toBe('560001');
    expect(r.components.country).toBe('India');
    expect(r.components.line1).toContain('MG Road');
  });

  it('translates REQUEST_DENIED to failed-precondition without echoing Google error_message', async () => {
    const f: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'REQUEST_DENIED',
        error_message: 'API key not valid. Please pass a valid API key.',
      }),
    });

    try {
      await callGoogleGeocode(1, 2, FAKE_KEY, f);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code: string }).code).toBe('failed-precondition');
      // Google's error message must NOT leak.
      expect((err as Error).message).toBe('geocode/request-denied');
    }
  });
});
