/**
 * BE-side re-export of the canonical AuthErrorCode Zod enum from
 * shared/contracts/auth. Provides a single import location for auth
 * callables and middleware so all BE-emitted wire codes go through
 * one type-checked surface.
 *
 * Mirrors `frontend/src/auth/error-codes.ts` (FE-AUTH-LAYOUT §2.11). The
 * shared contract file itself is byte-identical across FE and BE; ε4's
 * MD5-equality CI test asserts that invariant.
 */

export { AuthErrorCode } from '../shared/contracts/auth';
export type { AuthErrorCode as AuthErrorCodeT } from '../shared/contracts/auth';
