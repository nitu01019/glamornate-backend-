/**
 * Unit tests for buildMapsUrl — Phase 2 helper that formats a Google Maps
 * Directions URLs API link from a customerLocation snapshot.
 *
 * Spec: https://developers.google.com/maps/documentation/urls/get-started#directions-action
 */

import { describe, it, expect } from 'vitest';
import { buildMapsUrl } from '../maps-url';

describe('buildMapsUrl', () => {
  it('formats a base Maps directions URL when no placeId is present', () => {
    const url = buildMapsUrl({
      coords: { lat: 12.97, lng: 77.59 },
    });
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=12.97,77.59'
    );
  });

  it('appends destination_place_id when placeId is present', () => {
    const url = buildMapsUrl({
      coords: { lat: 12.97, lng: 77.59 },
      placeId: 'ChIJbU60yXAWrjsR4E9-UejD3_g',
    });
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=12.97,77.59&destination_place_id=ChIJbU60yXAWrjsR4E9-UejD3_g'
    );
  });

  it('formats lat/lng as raw decimals (no precision truncation)', () => {
    const url = buildMapsUrl({
      coords: { lat: 12.971598765, lng: 77.594562345 },
    });
    expect(url).toContain('destination=12.971598765,77.594562345');
  });

  it('URL-encodes placeIds containing special characters', () => {
    // Synthetic placeId with /+= chars to confirm encodeURIComponent is applied.
    const url = buildMapsUrl({
      coords: { lat: 0, lng: 0 },
      placeId: 'a/b+c=d',
    });
    expect(url).toContain('destination_place_id=a%2Fb%2Bc%3Dd');
  });

  it('treats empty-string placeId as missing (no destination_place_id appended)', () => {
    // While the contracts schema rejects '' via `.min(1)`, this protects
    // notification call-sites that may receive a stale snapshot from a
    // legacy doc with an empty placeId field.
    const url = buildMapsUrl({
      coords: { lat: 1, lng: 2 },
      placeId: '',
    });
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=1,2'
    );
  });

  it('handles negative coordinates (southern/western hemisphere)', () => {
    const url = buildMapsUrl({
      coords: { lat: -33.86, lng: -151.21 },
    });
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=-33.86,-151.21'
    );
  });
});
