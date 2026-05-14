/**
 * GET /search/suggestions — typeahead suggestions matching service name,
 * category, subcategory, or tags.
 */

import { Router, type Request, type Response } from 'express';
import { catalogServices } from '../../data/glamornate-catalog';
import { SuggestionQuerySchema, okResponse, type SuggestionQuery } from '../../shared/contracts';
import { validate, getValidated } from '../middleware/validate';

export const searchSuggestionsRouter = Router();

const MAX_QUERY_LENGTH = 100;
const MAX_SUGGESTIONS = 8;
// eslint-disable-next-line no-control-regex -- strip control characters from user input
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;

searchSuggestionsRouter.get(
  '/search/suggestions',
  validate('query', SuggestionQuerySchema),
  (req: Request, res: Response) => {
    try {
      const { q: rawQuery } = getValidated<SuggestionQuery>(req, 'query');
      const query = rawQuery
        .slice(0, MAX_QUERY_LENGTH)
        .trim()
        .replace(CONTROL_CHAR_REGEX, '');

      if (query.length < 2) {
        res.json(okResponse<string[]>([]));
        return;
      }

      const term = query.toLowerCase();
      const seen = new Set<string>();
      const suggestions: string[] = [];

      for (const service of catalogServices) {
        if (!service.isActive) continue;

        const nameLower = service.name.toLowerCase();
        const categoryLower = service.category.toLowerCase();
        const subcategoryLower = (service.subcategory ?? '').toLowerCase();

        const matches =
          nameLower.includes(term) ||
          categoryLower.includes(term) ||
          subcategoryLower.includes(term) ||
          service.tags.some((t) => t.toLowerCase().includes(term));

        if (matches && !seen.has(nameLower)) {
          seen.add(nameLower);
          suggestions.push(service.name);
          if (suggestions.length >= MAX_SUGGESTIONS) break;
        }
      }

      res.json(okResponse(suggestions));
    } catch {
      res.status(500).json({
        success: false,
        data: [],
        error: 'Suggestions unavailable.',
      });
    }
  },
);
