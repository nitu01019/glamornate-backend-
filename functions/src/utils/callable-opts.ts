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
 * Env override: `APP_CHECK_ENFORCED=false` flips `enforceAppCheck` to `false` at
 * deploy time. Used to match a project-level UNENFORCED state (e.g., during
 * sideloaded-APK testing before the build is on Play Console and Play Integrity
 * recognizes it). Per-callable overrides via `overrides` still win.
 *
 * Override per-callable via `overrides` (e.g., region, memory, timeoutSeconds, minInstances).
 */
export function callableOpts(overrides: CallableOptsOverrides = {}) {
  const { region, ...runtimeOverrides } = overrides;
  const enforceAppCheck = process.env.APP_CHECK_ENFORCED === 'false' ? false : true;
  const opts: RuntimeOptions = {
    enforceAppCheck,
    consumeAppCheckToken: false,
    ...runtimeOverrides,
  };
  const builder = functions.runWith(opts);
  return region ? builder.region(region) : builder;
}
