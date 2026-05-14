/**
 * Catalog types are defined in `@glamornate/data-catalog`.
 * This thin re-export preserves existing `./types` import paths elsewhere
 * in the backend tree.
 */

export type {
  ServiceCategory,
  HomeService,
  DiscountType,
  Promotion,
} from '../shared/catalog';
