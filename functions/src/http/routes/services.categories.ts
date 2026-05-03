/**
 * GET /services/categories — port of the frontend `/api/v1/services/categories`
 * route. Returns categories enriched with `serviceCount` and `priceRange`.
 */

import { Router, type Request, type Response } from 'express';
import { catalogCategories, catalogData } from '../../data/glamornate-catalog';
import { okResponse, errResponse, type Category } from '../../lib/contracts';

export const categoriesRouter = Router();

categoriesRouter.get('/services/categories', (_req: Request, res: Response) => {
  try {
    const categories: Category[] = catalogData
      .map((cat) => {
        const allPrices: number[] = [];
        let serviceCount = 0;

        for (const subcategory of cat.subcategories) {
          serviceCount += subcategory.items.length;
          for (const catalogItem of subcategory.items) {
            allPrices.push(catalogItem.price);
          }
        }

        const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : 0;
        const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : 0;

        const catEntry = catalogCategories.find((c) => c.id === cat.id);

        return {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          description: cat.description,
          image: catEntry?.image ?? `/images/categories/${cat.slug}.webp`,
          serviceCount,
          priceRange: { min: minPrice, max: maxPrice },
          ordering: cat.ordering,
        } satisfies Category;
      })
      .sort((a, b) => a.ordering - b.ordering);

    res
      .set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
      .json(okResponse(categories, { meta: { total: categories.length } }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch categories';
    res.status(500).json(errResponse(message));
  }
});
