import * as functions from 'firebase-functions';
import type { RuntimeOptions } from 'firebase-functions';

/**
 * Overrides accepted by `callableOpts`. Extends the v1 `RuntimeOptions` with
 * a convenience `region` field so callers can pin a function to a specific
 * Cloud Functions region (e.g., `us-central1`) without having to chain
 * `.region(...)` themselves.
 */
export type CallableOptsOverrides = RuntimeOptions & {
  /** Cloud Functions region (e.g., 'us-central1'). Applied via `.region(...)`. */
  region?: string;
};

/**
 * Shared builder for callable functions. Establishes App Check enforcement + sensible defaults.
 *
 * Defaults:
 *  - enforceAppCheck: true (reject requests without a valid App Check token)
 *  - consumeAppCheckToken: false (monitoring mode — do not burn the single-use token)
 *
 * Override per-callable via `overrides` (e.g., region, memory, timeoutSeconds, minInstances).
 */
export function callableOpts(overrides: CallableOptsOverrides = {}) {
  const { region, ...runtimeOverrides } = overrides;
  const opts: RuntimeOptions = {
    enforceAppCheck: true,
    consumeAppCheckToken: false,
    ...runtimeOverrides,
  };
  const builder = functions.runWith(opts);
  return region ? builder.region(region) : builder;
}
