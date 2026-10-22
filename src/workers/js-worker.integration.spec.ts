/**
 * Real-browser integration suite for the JS runner: a real Chromium
 * `Worker` running the bundled QuickJS worker (`defaultJsWorkerFactory`),
 * driven through the public `JsRunner`. Covers the cases the in-process
 * host cannot: terminate-based abort of a hot synchronous loop, and
 * superseding a run that is suspended on a host capability call.
 *
 * Run via: npm run test:integration. Under the jsdom unit suite (no `Worker`)
 * the suite is skipped.
 */
import { CapabilityStore, JsRunner, type SandboxCapability } from '../index.js';
import { defaultJsWorkerFactory } from './default-worker-factories.js';

const SUPERSEDED = 'Execution superseded by a newer run.';
const ABORTED = 'Execution aborted.';

describe.skipIf(typeof Worker === 'undefined')('JsRunner on a real Worker', () => {
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
  const echoCap: SandboxCapability = {
    name: 'echo',
    description: 'host call that answers at once',
    stubInfo: { name: 'echo', type: 'function' },
    invokeHost: async (_method, args) => args[0],
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
});
