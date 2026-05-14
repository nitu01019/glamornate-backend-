/**
 * De-Tan Pack — Per-Item Image Mapping
 * Keyed by service slug (matches toSlug() output).
 * Images: WebP, max 600px wide, in public/images/services/de-tan-pack/items/
 */

const BASE = '/images/services/de-tan-pack/items';

export const detanItemImages: Record<string, string> = {
  // Ozone D-Tan Cleanser (3)
  'ozone-d-tan-cleanser-face-neck': `${BASE}/ozone-d-tan-cleanser-face-neck.webp`,
  'ozone-d-tan-cleanser-hands-feet': `${BASE}/ozone-d-tan-cleanser-hands-feet.webp`,
  'ozone-d-tan-cleanser-full-arms': `${BASE}/ozone-d-tan-cleanser-full-arms.webp`,

  // Sara Oxy D-Tan Mask (3)
  'sara-oxy-d-tan-mask-face-neck': `${BASE}/sara-oxy-d-tan-mask-face-neck.webp`,
  'sara-oxy-d-tan-mask-hands-feet': `${BASE}/sara-oxy-d-tan-mask-hands-feet.webp`,
  'sara-oxy-d-tan-mask-full-arms': `${BASE}/sara-oxy-d-tan-mask-full-arms.webp`,

  // O3+ Professional D-Tan Pack (2)
  'o3-professional-d-tan-pack-face': `${BASE}/o3-professional-d-tan-pack-face.webp`,
  'o3-professional-d-tan-pack-full-arms': `${BASE}/o3-professional-d-tan-pack-full-arms.webp`,
};
