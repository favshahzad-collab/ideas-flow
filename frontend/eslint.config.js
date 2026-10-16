import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The codebase already marks deliberately-unused parameters with a
      // leading underscore (a callback that must match a signature it does
      // not need every argument of). Teach the linter that convention rather
      // than sprinkling disable comments at each site.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test files and their scaffolding are never hot-reloaded, so the rule
    // that keeps fast refresh working has nothing to protect here — and
    // obeying it would mean splitting every render helper away from the
    // wrapper component it exists to mount.
    files: ['**/*.test.ts', '**/*.test.tsx', 'src/test/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
