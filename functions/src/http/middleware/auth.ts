// Shim: relocation 2026-05-12 (ε5). Public exports preserved.
// The canonical implementation lives at backend/functions/src/auth/middleware.ts.
// The module augmentation `declare module 'express-serve-static-core'` in
// the new file applies globally once any path imports it.
export { verifyAuth } from '../../auth/middleware';
export type { AuthContext } from '../../auth/middleware';
