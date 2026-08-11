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
    linterOptions: {
      // Every eslint-disable in this codebase carries a reason. When the code it
      // covers changes and the suppression stops being needed, the comment stays
      // behind asserting something that is no longer true -- and a stale reason
      // is worse than none, because the next reader believes it.
      reportUnusedDisableDirectives: 'error',
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
      // Errors now. They landed as warnings because both fire where TypeScript
      // believes a guard is dead, and a type can be wrong about the wire in a
      // way that makes the "dead" guard the only thing preventing a crash. All
      // 17 have since been read against what the API and the browser actually
      // do, so the rules can be enforced and the exceptions are the documented
      // eslint-disable lines -- each one naming the type that lies and why.
      //
      // Report unused disables too: a suppression that outlives its problem is
      // how the next person learns to distrust every other one in the file.
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
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
