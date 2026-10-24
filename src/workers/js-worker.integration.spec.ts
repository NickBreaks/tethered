/**
 * Real-browser integration suite for the JS runner: a real Chromium
 * `Worker` running the bundled QuickJS worker (`defaultJsWorkerFactory`),
 * driven through the public `JsRunner`. Covers the cases that the
 * in-process host cannot cover: terminate-based abort of a hot synchronous
 * loop, and supersede of a run that is suspended on a host capability call.
 *
 * Run with: npm run test:integration. Under the jsdom unit suite (no `Worker`)
 * the suite is skipped.
 */
import { vi } from 'vitest';
import {
  CapabilityStore,
  FetchCapability,
  JsRunner,
  TimerCapability,
  type ProxyAuth,
  type SandboxCapability,
} from '../index.js';
import { defaultJsWorkerFactory } from './default-worker-factories.js';

const SUPERSEDED = 'Execution superseded by a newer run.';
const ABORTED = 'Execution aborted.';

const echoCap: SandboxCapability = {
  name: 'echo',
  description: 'host call that answers at once',
  stubInfo: { name: 'echo', type: 'function' },
  invokeHost: async (_method, args) => args[0],
};

describe('JsRunner on a real Worker', () => {
  let registry: CapabilityStore;
  let runner: JsRunner;
  /** Resolves when the guest reaches the never-resolving host call. */
  let hangReached: Promise<void>;
  let markHangReached: () => void;

  const hangCap: SandboxCapability = {
    name: 'hang',
    description: 'host call that never resolves',
    stubInfo: { name: 'hang', type: 'function' },
    invokeHost: () => {
      markHangReached();
      return new Promise<never>(() => {});
    },
  };

  beforeEach(async () => {
    hangReached = new Promise<void>((r) => (markHangReached = r));
    registry = new CapabilityStore();
    registry.register(hangCap);
    registry.register(echoCap);
    registry.setEnabled('hang', true);
    registry.setEnabled('echo', true);
    runner = new JsRunner(registry, { workerFactory: defaultJsWorkerFactory, timeoutMs: 60_000 });
    await runner.initialize();
  });

  afterEach(() => {
    runner.dispose();
  });

  it('A32: superseding a run suspended on a host call completes the new run within 5 s', async () => {
    const pA = runner.execute('console.log("a-before"); hang(); console.log("a-after"); "a"', {
      tag: 'A',
    });
    await hangReached;

    const t0 = performance.now();
    const pB = runner.execute('console.log("b"); echo(41) + 1', { tag: 'B' });
    const rA = await pA;
    expect(rA.success).toBe(false);
    expect(rA.timedOut).toBe(false);
    expect(rA.error).toBe(SUPERSEDED);

    const rB = await pB;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(rB.success).toBe(true);
    expect(rB.output.map((e) => e.content)).toEqual(['[hang, echo enabled]', 'b', '42']);
    expect(rA.output.map((e) => e.content)).toEqual([
      '[hang, echo enabled]',
      'a-before',
      SUPERSEDED,
    ]);
    expect(runner.isRunning.get()).toBe(false);
    expect(runner.activeTag.get()).toBeNull();
  }, 20_000);

  it('A33: abort() stops while (true) {} within 2 s and the next run succeeds', async () => {
    const p = runner.execute('while (true) {}');
    // Let the worker enter the loop.
    await new Promise((r) => setTimeout(r, 200));
    expect(runner.isRunning.get()).toBe(true);

    const t0 = performance.now();
    await runner.abort();
    const result = await p;
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error).toBe(ABORTED);

    const next = await runner.execute('40 + 2');
    expect(next.success).toBe(true);
    expect(next.output.at(-1)).toEqual(expect.objectContaining({ type: 'result', content: '42' }));
  }, 20_000);

  it.each([
    ["throw new Error('out of memory')"],
    ["throw { name: 'InternalError', message: 'out of memory' }"],
    ['function f() { f() } f()'],
  ])('%s fails once, with no retry and no worker replacement', async (code) => {
    const starts: string[] = [];
    const recycles: string[] = [];
    runner.onRun((info) => {
      if (info) starts.push(info.tag);
    });
    runner.onRecycle((reason) => recycles.push(reason));
    const result = await runner.execute(code, { tag: 'g' });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(starts).toEqual(['g']);
    expect(recycles).toEqual([]);
  }, 20_000);

  it('a thrown fake interrupt is an ordinary error, not a timeout', async () => {
    const result = await runner.execute("throw { name: 'InternalError', message: 'interrupted' }");
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error).toMatch(/^InternalError: interrupted/);
  }, 20_000);

  it('runs promise jobs and reports an async result without the timer capability', async () => {
    const result = await runner.execute(
      "Promise.resolve().then(() => console.log('x')); (async () => { await null; return 7 })()",
    );
    expect(result.success).toBe(true);
    expect(result.output.map((e) => e.content)).toEqual(['[hang, echo enabled]', 'x', '7']);
  }, 20_000);
});

describe('host calls in promise jobs and timers on a real Worker', () => {
  let runner: JsRunner;
  const originalFetch = globalThis.fetch;
  const stubProxyAuth = {
    proxyBase: () => null,
    authHeader: () => null,
    setToken: vi.fn(),
    clearToken: vi.fn(),
    invalidate: vi.fn(),
    tokenInvalid: () => false,
  } as unknown as ProxyAuth;

  beforeEach(async () => {
    const registry = new CapabilityStore();
    registry.register(new FetchCapability(stubProxyAuth));
    registry.register(new TimerCapability());
    registry.register(echoCap);
    for (const name of ['fetch', 'timer', 'echo']) registry.setEnabled(name, true);
    runner = new JsRunner(registry, { workerFactory: defaultJsWorkerFactory, timeoutMs: 10_000 });
    await runner.initialize();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    runner.dispose();
  });

  it('two sequential await fetch() calls in one async function give the result', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
    const result = await runner.execute(`(async () => {
      const a = await fetch('https://example.com/a');
      const b = await fetch('https://example.com/b');
      return a.status + b.status;
    })()`);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.output.filter((e) => e.type === 'result').map((e) => e.content)).toEqual(['400']);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  }, 20_000);

  it('a host call in a setTimeout callback gives its value', async () => {
    const result = await runner.execute(
      'new Promise((resolve) => setTimeout(() => resolve(echo(41) + 1), 10))',
    );
    expect(result.success).toBe(true);
    expect(result.output.filter((e) => e.type === 'result').map((e) => e.content)).toEqual(['42']);
  }, 20_000);

  it('an endless async loop that awaits a host call times out', async () => {
    const result = await runner.execute(
      '(async () => { let n = 0; while (true) { n = await echo(n + 1) } })()',
      { timeoutMs: 300 },
    );
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  }, 20_000);
});
