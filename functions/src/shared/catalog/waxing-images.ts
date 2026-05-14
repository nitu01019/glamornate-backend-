/**
 * Waxing — Per-Item Image Mapping
 *
 * Keyed by service slug (matches toSlug() output from glamornate-catalog.ts).
 * Service names follow the pattern `{WaxType} - {BodyArea}`, so:
 *   toSlug("Honey Wax - Underarms") => "honey-wax-underarms"
 *   (all non-alphanumeric sequences collapse to a single hyphen)
 *
 * Images are JPEG, max 600px wide, stored in:
 *   public/images/services/waxing/items/{wax-type}/
 */

const BASE = '/images/services/waxing/items';

// Body area image filenames shared across all wax types
const AREA_IMG: Record<string, string> = {
  underarms: 'underarms.jpg',
  'half-back': 'half-back.jpg',
  'full-arms': 'full-arms.jpg',
  'half-legs': 'half-legs.jpg',
  buttocks: 'buttocks.jpg',
  'full-arms-underarms': 'full-arms-underarms.jpg',
  stomach: 'stomach.jpg',
  'full-back': 'full-back.jpg',
  'full-legs': 'full-legs.jpg',
  'half-legs-half-arms': 'half-legs-half-arms.jpg',
  'half-legs-full-arms-underarms': 'half-legs-full-arms-underarms.jpg',
  'full-legs-full-arms-underarms': 'full-legs-full-arms-underarms.jpg',
  bikini: 'bikini.jpg',
  'full-body-excluding-bikini': 'full-body-excluding-bikini.jpg',
};

type WaxType = 'honey-wax' | 'neuron-wax' | 'raaga-bridal-wax' | 'rose-gel-wax' | 'rica-wax';

const WAX_TYPES: WaxType[] = [
  'honey-wax',
  'neuron-wax',
  'raaga-bridal-wax',
  'rose-gel-wax',
  'rica-wax',
];

/**
 * Build the full per-item image map keyed by service slug.
 * Each entry maps e.g. "honey-wax-underarms" => "/images/.../honey-wax/underarms.jpg"
 */
function buildWaxingImages(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const waxType of WAX_TYPES) {
    for (const [areaSuffix, filename] of Object.entries(AREA_IMG)) {
      const serviceSlug = `${waxType}-${areaSuffix}`;
      map[serviceSlug] = `${BASE}/${waxType}/${filename}`;
    }
  }
  return map;
}

export const waxingItemImages: Record<string, string> = buildWaxingImages();

/**
 * Look up the per-item image for a waxing service.
 * @param serviceSlug - The full service slug (e.g., "honey-wax-underarms")
 * @returns Image path or undefined if no specific image exists
 */
export function getWaxingItemImage(serviceSlug: string): string | undefined {
  return waxingItemImages[serviceSlug];
}
