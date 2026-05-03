/**
 * Manicure & Pedicure — Per-Item Image Mapping
 *
 * Keyed by service slug (matches toSlug() output from glamornate-catalog.ts).
 * All images are WebP, max 600px wide, stored in:
 *   public/images/services/manicure-pedicure/items/
 */

const BASE = '/images/services/manicure-pedicure/items';

export const maniPediItemImages: Record<string, string> = {
  // Manicure (5)
  'aroma-magic-manicure': `${BASE}/aroma-magic-manicure.webp`,
  'richelon-seashell-manicure': `${BASE}/richelon-seashell-manicure.webp`,
  'fyc-bubble-gum-manicure': `${BASE}/fyc-bubble-gum-manicure.webp`,
  'fyc-sugar-candy-manicure': `${BASE}/fyc-sugar-candy-manicure.webp`,
  'o3-professional-manicure': `${BASE}/o3-professional-manicure.webp`,

  // Pedicure (5)
  'fyc-sugar-candy-pedicure': `${BASE}/fyc-sugar-candy-pedicure.webp`,
  'fyc-bubble-gum-pedicure': `${BASE}/fyc-bubble-gum-pedicure.webp`,
  'aroma-magic-pedicure': `${BASE}/aroma-magic-pedicure.webp`,
  'richelon-seashell-pedicure': `${BASE}/richelon-seashell-pedicure.webp`,
  'o3-professional-pedicure': `${BASE}/o3-professional-pedicure.webp`,

  // Mani-Pedi Combo (5)
  'fyc-sugar-candy-mani-pedi': `${BASE}/fyc-sugar-candy-mani-pedi.webp`,
  'fyc-bubble-gum-mani-pedi': `${BASE}/fyc-bubble-gum-mani-pedi.webp`,
  'aroma-magic-mani-pedi': `${BASE}/aroma-magic-mani-pedi.webp`,
  'richelon-seashell-mani-pedi': `${BASE}/richelon-seashell-mani-pedi.webp`,
  'oxylife-aqua-mani-pedi': `${BASE}/oxylife-aqua-mani-pedi.webp`,
};
