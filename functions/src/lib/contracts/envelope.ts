import { z, ZodType, ZodTypeAny } from 'zod';

/**
 * ApiResponse envelope used by every Glamornate API endpoint (Next.js route
 * handlers, Firebase Cloud Functions HTTP + callable). Single source of truth
 * consumed by:
 *   - `frontend/src/lib/api-client.ts` — unwraps the envelope on success,
 *     throws typed ApiError on failure.
 *   - All `backend/functions/src/http/**` routes — construct via
 *     `okResponse` / `errResponse`.
 *   - All `frontend/src/app/api/v1/**` Next.js route handlers — same helpers.
 *
 * Shape:
 *   { success: boolean, data: T | null, error?: string | null,
 *     code?: string, requestId?: string,
 *     meta?: { total, page?, limit?, offset?, cursor? },
 *     fallbackLevel?: 'city' | 'backfill' | 'platform',
 *     didYouMean?: string }
 */
export const MetaSchema = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  /**
   * Optional keyset-pagination cursor returned by list endpoints that paginate
   * by ref (e.g. spa directory with featuredRank + name ordering).
   */
  cursor: z.string().optional(),
});

export type ApiMeta = z.infer<typeof MetaSchema>;

export const FallbackLevelSchema = z.enum(['city', 'backfill', 'platform']);
export type FallbackLevel = z.infer<typeof FallbackLevelSchema>;

/**
 * Generic envelope factory. Given a zod schema for `data`, returns the full
 * ApiResponse<T> schema that wraps it.
 */
export function apiResponseSchema<T extends ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean(),
    data: dataSchema.nullable(),
    error: z.string().nullable().optional(),
    code: z.string().optional(),
    requestId: z.string().optional(),
    meta: MetaSchema.optional(),
    fallbackLevel: FallbackLevelSchema.optional(),
    didYouMean: z.string().optional(),
  });
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error?: string | null;
  /**
   * Machine-readable error code. Used by `frontend/src/lib/api-client.ts` to
   * detect `TOKEN_EXPIRED_CODE` and trigger a forced token refresh + retry.
   */
  code?: string;
  /** Request-scoped correlation id for log tracing. */
  requestId?: string;
  meta?: ApiMeta;
  fallbackLevel?: FallbackLevel;
  didYouMean?: string;
}

/**
 * HTTP methods supported by the unified API client.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Sentinel error code emitted by the backend when an auth token has expired.
 * The api-client listens for this code + envelope.error variant and forces
 * `getIdToken(true)` followed by a single retry.
 */
export const TOKEN_EXPIRED_CODE = 'token-expired' as const;

/**
 * Helpers for building API responses in a uniform way.
 */
export function okResponse<T>(data: T, extra: Partial<ApiResponse<T>> = {}): ApiResponse<T> {
  return { success: true, data, error: null, ...extra };
}

export function errResponse<T = null>(
  error: string,
  extra: Partial<ApiResponse<T>> = {},
): ApiResponse<T> {
  return { success: false, data: null as T | null, error, ...extra };
}

/**
 * Type helper equivalent to `z.infer` for an envelope.
 */
export type InferApiResponse<T extends ZodType> = ApiResponse<z.infer<T>>;
