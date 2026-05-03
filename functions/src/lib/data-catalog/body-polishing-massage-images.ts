/**
 * Body Polishing & Massage — Per-Item Image Mapping
 * Keyed by service slug (matches toSlug() output).
 * Images: WebP, max 600px wide, in public/images/services/body-polishing-massage/items/
 */

const BASE = '/images/services/body-polishing-massage/items';

export const bodyPolishingMassageItemImages: Record<string, string> = {
  // Body Polishing (2)
  'vedicline-kamayani-body-polishing': `${BASE}/vedicline-kamayani-body-polishing.webp`,
  'ozone-intenso-hydrate-cocoa-body-polishing': `${BASE}/ozone-intenso-hydrate-cocoa-body-polishing.webp`,

  // Body Massage (6)
  'specific-body-part-massage-10-minutes': `${BASE}/specific-body-part-massage-10-minutes.webp`,
  'specific-body-part-massage-20-minutes': `${BASE}/specific-body-part-massage-20-minutes.webp`,
  'face-neck-massage-25-minutes': `${BASE}/face-neck-massage-25-minutes.webp`,
  'specific-body-part-massage-30-minutes': `${BASE}/specific-body-part-massage-30-minutes.webp`,
  'full-body-massage-45-minutes': `${BASE}/full-body-massage-45-minutes.webp`,
  'full-body-massage-60-minutes': `${BASE}/full-body-massage-60-minutes.webp`,
};
