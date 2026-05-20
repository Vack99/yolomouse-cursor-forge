// Flat ESLint config for studio/. Minimal on purpose: the load-bearing
// rule is `react-hooks/rules-of-hooks`, which would have caught the
// black-screen bug from the editor slice (#13) at write-time instead of
// only in the browser. `exhaustive-deps` is warn-only because the noise
// rarely matches real bugs; treat warnings as informational.
//
// `no-undef` is off because TypeScript already catches undefined
// identifiers, and turning it on without populating Node/browser globals
// would just produce false positives.
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-undef': 'off',
    },
  },
  {
    // Test files use vitest's imports (not globals), so the same ruleset
    // is fine. Excluding `dist/` and `node_modules/` is handled by the
    // `files` glob above only matching `src/`.
    ignores: ['dist/**', 'node_modules/**', 'vite.config.ts'],
  },
];
