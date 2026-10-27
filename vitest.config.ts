import { defineConfig } from 'vitest/config';

/**
 * Unit suite: jsdom, no real `Worker`. Specs that need the engine run it
 * in-process (`createJsWorkerFactory({ allowInProcess: true })` or a
 * QuickJS context created directly). The real-browser suite is
 * vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['src/**/*.integration.spec.ts'],
    environment: 'jsdom',
    globals: true,
    // `npm run test:coverage` uses these settings. The minimums are a little
    // below the current values, thus a large drop fails the run. The
    // integration suite covers the IndexedDB code. Thus the values for that
    // code are low here.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 91,
        branches: 88,
        functions: 86,
        lines: 93,
      },
    },
  },
});
