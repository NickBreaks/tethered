import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * Real-browser integration suite: Playwright Chromium (headless), a real
 * `Worker` running the worker script, driven through the public API.
 * It is separate from the jsdom unit suite, because it needs a browser and
 * longer budgets.
 *
 * Run with:  npm run test:integration
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
