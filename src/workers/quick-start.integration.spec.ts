/**
 * The README quick start, run as written (bar the worker URL import) on
 * a real Chromium `Worker`, with the page's `fetch` stubbed.
 *
 * Run via: npm run test:integration.
 */
import { createSandboxRuntime, FetchCapability } from '../index.js';
import { defaultJsWorkerFactory } from './default-worker-factories.js';

describe.skipIf(typeof Worker === 'undefined')('README quick start', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches through an allowed host and refuses others', async () => {
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify([1, 2, 3]), { status: 200 });
    };

    const rt = createSandboxRuntime({ jsWorkerFactory: defaultJsWorkerFactory });
    try {
      rt.registry.register(new FetchCapability(rt.auth, { allowHosts: ['api.example.com'] }));
      rt.registry.setEnabled('fetch', true);
      await rt.js.initialize();

      const result = await rt.facade.execute(`
        const res = fetch('https://api.example.com/items'); // host calls look synchronous to the guest
        console.log(res.status);
        res.json().length
      `);
      expect(result.success).toBe(true);
      expect(result.output.map((e) => e.content)).toEqual(['[fetch enabled]', '200', '3']);
      expect(seen).toEqual(['https://api.example.com/items']);

      const refused = await rt.facade.execute(`fetch('https://evil.example.net/')`);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('is not allowed');
      expect(seen).toHaveLength(1);
    } finally {
      rt.dispose();
    }
  }, 30_000);
});
