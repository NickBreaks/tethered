import tseslint from 'typescript-eslint';

// The core (src/index.ts, src/lib/) is dependency-free and must not reach
// the workers. Mirrored by src/lib/core-import-guard.spec.ts and, after the
// build, by scripts/verify-build.mjs.
const NO_WORKERS_IN_CORE = {
  group: ['**/workers', '**/workers/**', '**/js-worker', '**/js-worker.js'],
  message: 'The core entry must not reference the worker modules; they live in src/workers/.',
};
const NO_PACKAGES_IN_CORE = {
  regex: '^[^.]',
  message: 'The core entry has no dependencies; the engine is imported only by src/workers/.',
};

// The workers reach the core only through its public entry.
const CORE_PUBLIC_ENTRY_ONLY = {
  group: ['../lib/**', '../../lib/**'],
  message: "Import the core from its public entry ('../index.js'), not from src/lib/.",
};

export default tseslint.config(
  {
    ignores: ['dist/', 'demo/dist/', 'node_modules/', 'coverage/', '**/__screenshots__/'],
  },
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.recommended],
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['src/index.ts', 'src/lib/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [NO_WORKERS_IN_CORE, NO_PACKAGES_IN_CORE] },
      ],
    },
  },
  {
    files: ['src/workers/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [CORE_PUBLIC_ENTRY_ONLY] }],
    },
  },
);
