import { vi } from 'vitest';
import { createJsWorkerFactory } from './index.js';
import { JsRunner } from '../lib/js/js-runner.js';
import { CapabilityStore } from '../lib/capabilities/capability-store.js';
import { FetchCapability } from '../lib/capabilities/fetch-capability.js';
import { StorageCapability } from '../lib/capabilities/storage-capability.js';
import { TimerCapability } from '../lib/capabilities/timer-capability.js';
import type { SandboxCapability } from '../lib/capabilities/capability.js';
import type { ProxyAuth } from '../lib/proxy/proxy-auth.js';
import type { ExecutionResult } from '../lib/shared/sandbox-types.js';

// Host calls must suspend the engine in all the places where guest code
// runs: the script, the promise jobs and the timer callbacks. These specs
// use JsRunner with the in-process engine. The in-process engine cannot
// stop a hot synchronous loop, thus each spec has a vitest timeout.

const stubProxyAuth = {
  proxyBase: () => null,
  authHeader: () => null,
  setToken: vi.fn(),
  clearToken: vi.fn(),
  invalidate: vi.fn(),
  tokenInvalid: () => false,
} as unknown as ProxyAuth;

const echoCap: SandboxCapability = {
  name: 'echo',
  description: 'host call that answers with its first argument',
  stubInfo: { name: 'echo', type: 'function' },
  invokeHost: async (_method, args) => args[0],
};

const boomCap: SandboxCapability = {
  name: 'boom',
  description: 'host call that always fails',
  stubInfo: { name: 'boom', type: 'function' },
  invokeHost: async () => {
    throw new Error('boom failed');
  },
};

function results(result: ExecutionResult): string[] {
  return result.output.filter((e) => e.type === 'result').map((e) => e.content);
}

function logs(result: ExecutionResult): string[] {
  return result.output.filter((e) => e.type === 'log').map((e) => e.content);
}

describe('host calls outside the top-level script', () => {
  let runner: JsRunner;
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    const registry = new CapabilityStore();
    registry.register(new FetchCapability(stubProxyAuth));
    registry.register(
      new StorageCapability({
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      }),
    );
    registry.register(new TimerCapability());
    registry.register(echoCap);
    registry.register(boomCap);
    for (const name of ['fetch', 'storage', 'timer', 'echo', 'boom'])
      registry.setEnabled(name, true);
    runner = new JsRunner(registry, {
      workerFactory: createJsWorkerFactory({ allowInProcess: true }),
    });
    await runner.initialize();
  }, 30_000);

  afterAll(() => {
    runner.dispose();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.clear();
  });

  it('two sequential await fetch() calls in one async function give the result', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
    const result = await runner.execute(
      `(async () => {
        const a = await fetch('https://example.com/a');
        const b = await fetch('https://example.com/b');
        return a.status + b.status;
      })()`,
      { timeoutMs: 3000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(results(result)).toEqual(['400']);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  }, 15_000);

  it('a host call in a .then() callback gives its value', async () => {
    store.set('n', 'five');
    const result = await runner.execute("Promise.resolve().then(() => storage.getItem('n'))", {
      timeoutMs: 3000,
    });
    expect(result.success).toBe(true);
    expect(results(result)).toEqual(['five']);
  }, 15_000);

  it('a host call in a setTimeout callback gives its value', async () => {
    const result = await runner.execute(
      `new Promise((resolve) => {
        setTimeout(() => { console.log('t ' + echo(7)); resolve(echo(8) + 1) }, 10);
      })`,
      { timeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(logs(result)).toEqual(['t 7']);
    expect(results(result)).toEqual(['9']);
  }, 15_000);

  it('a host error in a promise job throws in the guest', async () => {
    const result = await runner.execute(
      `(async () => {
        await null;
        try { boom(); return 'no error' } catch (e) { return 'caught ' + e.message }
      })()`,
      { timeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(results(result)).toEqual(['caught boom failed']);
  }, 15_000);

  it('an endless async loop that awaits a host call times out', async () => {
    const result = await runner.execute(
      '(async () => { let n = 0; while (true) { n = await echo(n + 1) } })()',
      { timeoutMs: 300 },
    );
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  }, 15_000);

  it('a host call where the engine cannot suspend is a guest error, not a hang', async () => {
    // console.log reads its argument synchronously and calls toJSON. The
    // engine cannot suspend there.
    const result = await runner.execute(
      `(async () => {
        await null;
        let seen = 'no error';
        console.log({
          toJSON() {
            try { echo('inner'); } catch (e) { seen = e.message; }
            return 'x';
          },
        });
        return seen + ' / ' + echo('after');
      })()`,
      { timeoutMs: 3000 },
    );
    expect(result.success).toBe(true);
    expect(logs(result)).toEqual(['x']);
    expect(results(result)).toEqual([
      'echo() cannot run here: a host call cannot suspend the engine in this place. / after',
    ]);
  }, 15_000);
});
