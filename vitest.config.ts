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
  },
});
