import js from '@eslint/js'
import globals from 'globals'

/**
 * Flat config for a repository whose two shipped halves run in different worlds:
 *
 * - `lib/index.js` is the Node-half ESM plugin (node globals, module scope);
 * - `lib/client.js` is the browser bundle: a CJS-style factory handed to
 *   `window.__ModuleLoader__.load`, so it is script-scoped and knowingly uses
 *   browser globals;
 * - `tests/**` are Node ESM tests driving `node:test`;
 * - `src/index.ts` mirrors `lib/index.js` as plain source (no build step).
 *
 * Warnings are reported but do not fail the hook; real rule violations do.
 */
export default [
  { ignores: ['node_modules/**', 'lib/types/**', '*.tgz', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['lib/index.js', 'src/index.ts', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // The tests run under Node but the inline/DOM suites stand up a document
      // stand-in, so both worlds are legitimately reachable here.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The bundle deliberately probes optional runtime shapes (`?.` chains are
      // fine, but a few fallbacks are written as assignments in conditions).
      'no-cond-assign': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
]
