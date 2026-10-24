import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createJsWorkerFactory } from '../../workers/index.js';
import { JsRunner } from '../js/js-runner.js';
import { CapabilityStore } from './capability-store.js';
import { FetchCapability } from './fetch-capability.js';
import { TimerCapability } from './timer-capability.js';
import type { ProxyAuth } from '../proxy/proxy-auth.js';
import type { ExecutionResult } from '../shared/sandbox-types.js';

// Runs guest code through JsRunner with the in-process engine. The timer
// capability is enabled, so the runner drains the guest promise jobs. The
// engine runs in-process and cannot stop a job chain that never ends.
// Thus each spec has a vitest timeout.

const stubProxyAuth = {
  proxyBase: () => null,
  authHeader: () => null,
  setToken: vi.fn(),
  clearToken: vi.fn(),
  invalidate: vi.fn(),
  tokenInvalid: () => false,
} as unknown as ProxyAuth;

function logs(result: ExecutionResult): string[] {
  return result.output.filter((e) => e.type === 'log').map((e) => e.content);
}

describe('FetchCapability through JsRunner', () => {
  let runner: JsRunner;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    const registry = new CapabilityStore();
    runner = new JsRunner(registry, {
      workerFactory: createJsWorkerFactory({ allowInProcess: true }),
    });
    await runner.initialize();
    registry.register(new FetchCapability(stubProxyAuth));
    registry.register(new TimerCapability());
    registry.setEnabled('fetch', true);
    registry.setEnabled('timer', true);
  }, 30_000);

  afterAll(() => {
    runner.dispose();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): void {
    globalThis.fetch = vi.fn().mockImplementation(impl);
  }

  it('await fetch(url) and await r.json() complete the run', async () => {
    mockFetch(async () => new Response('{"a":41}', { status: 200 }));
    const result = await runner.execute(
      `(async function () {
        var r = await fetch('https://example.com/');
        var d = await r.json();
        console.log(r.status + ':' + (d.a + 1));
      })();`,
      { timeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(logs(result)).toEqual(['200:42']);
  }, 15_000);

  it('sync access and a .then() chain work in the same run', async () => {
    mockFetch(async () => new Response('hello', { status: 200 }));
    const result = await runner.execute(
      `var r = fetch('https://example.com/');
      console.log('sync ' + r.status + ' ' + r.text());
      r.then(function (x) { return x.text(); })
        .then(function (t) { console.log('then ' + t); });`,
      { timeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(logs(result)).toEqual(['sync 200 hello', 'then hello']);
  }, 15_000);

  it('an abort of the run aborts the host request in flight', async () => {
    let signal: AbortSignal | undefined;
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const run = runner.execute(`fetch('https://example.com/slow');`, { timeoutMs: 10_000 });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);

    runner.abort();
    const result = await run;

    expect(result.success).toBe(false);
    expect(signal!.aborted).toBe(true);
    await vi.waitFor(() => expect(runner.ready.get()).toBe(true));
  }, 15_000);
});
