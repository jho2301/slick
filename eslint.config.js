import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

/**
 * Type-aware lint over every TypeScript source. The JavaScript that remains
 * (bin shims, test fixtures spawned as executables, the Electron scripts) is
 * deliberately outside: it carries no types for the type-aware rules to use.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.tsbuild/**',
      '**/dist/**',
      'packages/server/public/**',
      'apps/web-legacy/**',
      'apps/web/dev-dist/**',
      '.claude/**',
      '.agents/**',
      '.local/**',
      'shots/**',
      'plugins/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // Node's type stripping needs `import type` for anything that is only
      // a type; this is the lint-time mirror of `verbatimModuleSyntax`.
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // The codebase reports through thrown errors with `.code`; narrowing
      // every `unknown` catch to a typed shape is done by helpers, not casts.
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      // Untrusted input (JSON, argv, a manifest someone typed) is coerced with
      // String() on purpose; the rule cannot tell that from a mistake.
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      // Tests read parsed JSON off the wire; typing every response shape
      // would be a second copy of the code under test.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  }
);
