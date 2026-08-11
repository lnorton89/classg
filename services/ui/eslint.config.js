import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'public/mockServiceWorker.js',
      'src/routeTree.gen.ts',
      'src/lib/api/schema.gen.ts',
    ],
  },

  // Application source: type-aware linting.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `onClick={() => mutate()}` is the idiom this codebase is written in, and
      // the handler's return value is discarded by React either way. Configured
      // rather than switched off: returning a void expression anywhere OTHER
      // than an arrow shorthand is still a genuine mistake.
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],
      // Interpolating a number is safe and everywhere -- `${count} detections`.
      // Objects and nullables still error, which is the case that actually
      // produces "[object Object]" in the UI.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Warn, not error, and deliberately so. Both rules fire where TypeScript
      // believes a guard is dead -- but the API types are GENERATED from the
      // schema and describe the contract, not the wire. A sensor that omits an
      // optional field still parses, so a check TypeScript calls unnecessary can
      // be the one keeping a panel from throwing. Each of these needs reading
      // against the real payload before it is removed; silencing them wholesale
      // in one pass is how a green lint run becomes a runtime crash.
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // The whole point of a typed contract is that `any` never appears.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // TanStack Router route files export a `Route` const alongside components.
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true, allowExportNames: ['Route'] },
      ],
    },
  },

  // Config + scripts run in Node and are not part of the app program.
  {
    files: ['*.{ts,js}', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      globals: globals.node,
    },
  },
)
