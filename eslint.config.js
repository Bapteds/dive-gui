// Flat ESLint config (ESLint 9) for the DIVE Turbinen monorepo.
// Covers the API (plain TypeScript) and the web app (TypeScript + React).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // Globally ignored paths. Config files are ignored so they do not require
  // type-aware parsing, keeping `eslint .` fast and dependency-light.
  {
    ignores: [
      '**/dist',
      '**/node_modules',
      'apps/api/prisma/migrations',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },

  // Base JavaScript + TypeScript recommended rules for every source file.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Allow intentionally-unused identifiers when prefixed with an underscore.
  // This keeps required-but-unused params (e.g. Express error handlers) clean.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
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

  // Node-oriented globals for the backend (CommonJS Express service).
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Browser globals + React-specific rules for the frontend app.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
