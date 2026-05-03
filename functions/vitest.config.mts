import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Limit test discovery to src/. The compiled `lib/` mirror used to leak
    // duplicate `.js` test files into the run, which caused CJS-import
    // failures since the source files are ESM-style.
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'lib/**', '.deploy-staging/**'],
    // Run test files sequentially. Several emulator-backed suites
    // (applyVoucher, cancelBooking, mergeUserAccounts) call
    // `clearCollection('bookings')` in their `beforeEach`, which torpedoes
    // any concurrent suite that has just seeded a booking against the same
    // shared Firestore emulator. Sequential execution is the surgical fix
    // until the suites are migrated to use file-scoped collection prefixes.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'lib/**'],
      // DEV-M2: start low so CI does not block existing work, then ratchet
      // by +5pp per quarter. See REMEDIATION_PLAN.md DEV-M2.
      thresholds: {
        lines: 50,
        branches: 50,
        functions: 50,
        statements: 50,
      },
    },
  },
})
