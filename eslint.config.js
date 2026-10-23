import tseslint from 'typescript-eslint';

// The core (src/index.ts, src/lib/) is dependency-free and must not reach
// the workers. src/lib/core-import-guard.spec.ts mirrors these rules.
// After the build, scripts/verify-build.mjs also mirrors them.
const NO_WORKERS_IN_CORE = {
  group: ['**/workers', '**/workers/**', '**/js-worker', '**/js-worker.js'],
  message: 'The core entry must not reference the worker modules; they live in src/workers/.',
};
const NO_PACKAGES_IN_CORE = {
  regex: '^[^.]',
  message: 'The core entry has no dependencies; the engine is imported only by src/workers/.',
};

// The workers import only the core modules that make the worker contract:
// the protocol, the shared types and helpers, and the capability stub
// type. They do not import the core entry. That entry pulls in the runner
// and all capabilities.
const workerCoreImports = (up) => ({
  regex: `^${up.replaceAll('.', '\\.')}(index(\\.js)?$|lib/(?!shared/|js/worker-protocol\\.js$|capabilities/capability\\.js$))`,
  message:
    'Worker modules import only lib/shared/, lib/js/worker-protocol.js and lib/capabilities/capability.js from the core.',
});

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
      'no-restricted-imports': ['error', { patterns: [workerCoreImports('../')] }],
    },
  },
  {
    files: ['src/js-worker.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [workerCoreImports('./')] }],
    },
  },
);
