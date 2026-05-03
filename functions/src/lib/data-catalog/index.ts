/**
 * @glamornate/data-catalog — canonical service catalog for Glamornate.
 *
 * Re-exports:
 *   - Catalog shape types (HomeService, ServiceCategory, Promotion, etc.) from ./types
 *   - Catalog data, derivers, and lookup helpers from ./catalog
 *   - Per-item image maps from each ./<category>-images module
 *
 * Consumers on both frontend and backend import from this package; thin shims
 * at `frontend/src/data/glamornate-catalog.ts` and
 * `backend/functions/src/data/glamornate-catalog.ts` re-export these symbols
 * so existing import paths continue to resolve during the transition.
 */

export * from './types';
export * from './catalog';

export { facialItemImages } from './facial-images';
export type { FacialImageMeta } from './facial-images';
export { maniPediItemImages } from './manicure-pedicure-images';
export { getWaxingItemImage, waxingItemImages } from './waxing-images';
export { cleanupItemImages } from './cleanup-images';
export { bleachItemImages } from './bleach-images';
export { threadingItemImages } from './threading-images';
export { bodyPolishingMassageItemImages } from './body-polishing-massage-images';
export { detanItemImages } from './detan-images';
