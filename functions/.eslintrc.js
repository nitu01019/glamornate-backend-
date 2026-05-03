// Phase 9 (2026-04-25): Dropped `plugin:prettier/recommended` and
// `plugin:firebase/recommended` from `extends`. Neither plugin is installed
// in `package.json` and ESLint was failing to resolve them at lint time.
// We deliberately do NOT add the deps — formatting is handled by Prettier
// directly (no plugin needed) and the `firebase` plugin is dormant. The
// remaining `@typescript-eslint/recommended` ruleset still enforces the
// type-safety bar required for Cloud Functions code.
module.exports = {
  parser: '@typescript-eslint/parser',
  extends: ['plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['lib', '*.js'],
  rules: {
    'no-console': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'import/no-extraneous-dependencies': 'off',
  },
};
