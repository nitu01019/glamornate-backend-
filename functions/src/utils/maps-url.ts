/**
 * Maps deep-link URL builder for notification templates.
 *
 * Phase 2 — used inside email/SMS templates to inject a tappable Google Maps
 * directions URL on home-service bookings. Pure function (no SDK calls), so
 * it is unit-testable in isolation.
 *
 * URL shape (Google Maps Directions URLs API):
 *   https://www.google.com/maps/dir/?api=1
 *     &destination=${lat},${lng}
 *     &destination_place_id=${placeId}     ← optional
 *
 * `destination_place_id` is preferred when available because it makes the
 * Maps app pin to the exact business/place rather than the raw lat/lng,
 * which is more accurate for technician dispatch when the customer captured
 * their address via Places autocomplete.
 *
 * Reference: https://developers.google.com/maps/documentation/urls/get-started#directions-action
 */

const MAPS_DIRECTIONS_BASE = 'https://www.google.com/maps/dir/?api=1';

export interface BuildMapsUrlInput {
  coords: { lat: number; lng: number };
  placeId?: string;
}

export function buildMapsUrl(loc: BuildMapsUrlInput): string {
  const base = `${MAPS_DIRECTIONS_BASE}&destination=${loc.coords.lat},${loc.coords.lng}`;
  if (loc.placeId && loc.placeId.length > 0) {
    return `${base}&destination_place_id=${encodeURIComponent(loc.placeId)}`;
  }
  return base;
}
