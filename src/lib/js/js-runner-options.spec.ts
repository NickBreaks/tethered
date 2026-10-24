import { vi } from 'vitest';
import { JsRunner, type JsRunnerOptions, type RunInfo } from './js-runner.js';
import { CapabilityStore } from '../capabilities/capability-store.js';
import type { SandboxCapability } from '../capabilities/capability.js';
import type { ExecutionResult, OutputEntry } from '../shared/sandbox-types.js';
import type { JsMainToWorkerMsg, JsWorkerToMainMsg } from './worker-protocol.js';

// Run-lifecycle features (per-run options, activeTag, streaming,
// queueing, recycling, exhaustion recovery), driven through a scripted
// fake worker so each worker→main message is under the test's control.

type RunMsg = Extract<JsMainToWorkerMsg, { type: 'run' }>;

/**
 * Scripted stand-in for the QuickJS worker: reports ready, records posts.
 * Listeners are called directly, not through an EventTarget. Thus an
 * exception from the runner's message handler fails the test. The DOM's
 * error reporting does not swallow it.
 */
class FakeJsWorker {
  readonly posts: JsMainToWorkerMsg[] = [];
  readonly #listeners = new Map<string, Set<(e: Event) => void>>();
  postMessage = vi.fn((msg: JsMainToWorkerMsg) => {
    this.posts.push(msg);
  });
  terminate = vi.fn();

  constructor(autoReady = true) {
    if (autoReady) queueMicrotask(() => this.simulate({ type: 'ready' }));
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }

  simulate(msg: JsWorkerToMainMsg): void {
    this.simulateRaw(msg);
  }

  /** Posts any value, as an untrusted worker can. Exceptions from listeners propagate. */
  simulateRaw(data: unknown): void {
    const event = new MessageEvent('message', { data });
    for (const fn of [...(this.#listeners.get('message') ?? [])]) fn(event);
  }

  /** Fires the worker's `error` event, as a script that failed to load does. */
  simulateError(message: string): void {
    const event = new ErrorEvent('error', { message });
    for (const fn of [...(this.#listeners.get('error') ?? [])]) fn(event);
  }

  get runs(): RunMsg[] {
    return this.posts.filter((m): m is RunMsg => m.type === 'run');
  }

  /** Ends run `runId` the way the worker does. */
  done(
    runId: number,
    extra: { success?: boolean; error?: string; timedOut?: boolean; exhausted?: boolean } = {},
  ): void {
    this.simulate({
      type: 'done',
      runId,
      success: extra.success ?? true,
      timedOut: extra.timedOut ?? false,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.exhausted !== undefined ? { exhausted: extra.exhausted } : {}),
    });
  }
}

/** Lets microtasks and a macrotask turn run (respawns, chain hops). */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** `p`'s value if it settles within a few microtask turns, else 'pending' (fake-timer safe). */
async function state<T>(p: Promise<T>): Promise<'pending' | T> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return Promise.race([p, Promise.resolve('pending' as const)]);
}

const OOM = 'InternalError: out of memory';

describe('JsRunner run lifecycle', () => {
  let registry: CapabilityStore;
  let workers: FakeJsWorker[];
  let runner: JsRunner;

  async function build(options: Omit<JsRunnerOptions, 'workerFactory'> = {}): Promise<JsRunner> {
    runner = new JsRunner(registry, {
      ...options,
      workerFactory: () => {
        const w = new FakeJsWorker();
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    await runner.initialize();
    return runner;
  }

  const current = () => workers[workers.length - 1];

  beforeEach(() => {
    registry = new CapabilityStore();
    workers = [];
  });

  afterEach(() => {
    runner?.dispose();
    vi.useRealTimers();
  });

  describe("concurrency: 'supersede' (default)", () => {
    const SUPERSEDED = 'Execution superseded by a newer run.';

    it('settles the older run as superseded at once and posts the new one to a fresh worker', async () => {
      const cleanup = vi.fn();
      registry.register({
        name: 'res',
        description: 'has cleanup',
        stubInfo: { name: 'res', type: 'function' },
        invokeHost: async () => 1,
        cleanup,
      });
      registry.setEnabled('res', true);
      await build();
      const events: string[] = [];
      runner.onRun((e) => events.push(e === null ? 'end' : `start:${e.tag}`));
      runner.onOutput((e) => events.push(`out:${e.content}`));

      const p1 = runner.execute('a()', { tag: 'old' });
      await settle();
      const old = current().runs[0];
      current().simulate({
        type: 'output',
        runId: old.runId,
        entry: { type: 'log', content: 'partial', timestamp: 1 },
      });
      events.length = 0;

      const p2 = runner.execute('b()', { tag: 'new' });
      // As documented on `isRunning`: while the new run waits for the
      // replacement worker it counts as running but has no tag yet.
      expect(runner.isRunning.get()).toBe(true);
      expect(runner.activeTag.get()).toBeNull();
      expect(await state(p1)).not.toBe('pending');
      const r1 = await p1;
      expect(r1).toEqual({
        success: false,
        timedOut: false,
        error: SUPERSEDED,
        durationMs: expect.any(Number),
        output: [
          expect.objectContaining({ type: 'system', content: '[res enabled]' }),
          expect.objectContaining({ type: 'log', content: 'partial' }),
          expect.objectContaining({ type: 'system', content: SUPERSEDED }),
        ],
      });
      expect(cleanup).toHaveBeenCalledOnce();
      // The superseded run is settled while the new worker boots.
      expect(runner.isRunning.get()).toBe(true);
      await settle();
      expect(workers).toHaveLength(2);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(workers[0].runs.map((r) => r.code)).toEqual(['a()']);
      expect(workers[1].runs.map((r) => r.code)).toEqual(['b()']);
      // Old run ends (with its superseded entry) before the new one starts.
      expect(events).toEqual([`out:${SUPERSEDED}`, 'end', 'start:new', 'out:[res enabled]']);
      expect(runner.activeTag.get()).toBe('new');
      expect(runner.isRunning.get()).toBe(true);
      expect(runner.queued.get()).toBe(0);

      // Late messages for the superseded run are ignored.
      events.length = 0;
      workers[0].simulate({
        type: 'output',
        runId: old.runId,
        entry: { type: 'log', content: 'late', timestamp: 2 },
      });
      workers[0].done(old.runId);
      current().done(old.runId);
      expect(events).toEqual([]);
      expect(runner.activeTag.get()).toBe('new');

      const fresh = current().runs[0];
      current().simulate({
        type: 'output',
        runId: fresh.runId,
        entry: { type: 'log', content: 'mine', timestamp: 3 },
      });
      current().done(fresh.runId);
      const r2 = await p2;
      expect(r2.success).toBe(true);
      expect(r2.output.map((e) => e.content)).toEqual(['[res enabled]', 'mine']);
      expect(r1.output).toHaveLength(3);
      expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it("clears the superseded run's backstop timer", async () => {
      await build({ timeoutMs: 100 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p1 = runner.execute('a()');
      const p2 = runner.execute('b()', { timeoutMs: 10_000 });
      expect((await p1).error).toBe(SUPERSEDED);
      await state(Promise.resolve());
      expect(workers).toHaveLength(2);
      expect(workers[1].runs.map((r) => r.code)).toEqual(['b()']);
      // Only the backstop of b stays armed. The kill of an old backstop has
      // a runId guard, so only the timer count shows a leaked timer.
      expect(vi.getTimerCount()).toBe(1);
      // Past the backstop of a (100 + 2000 ms): nothing fires, b still runs.
      vi.advanceTimersByTime(5000);
      expect(await state(p2)).toBe('pending');
      expect(workers[1].terminate).not.toHaveBeenCalled();
      expect(runner.isRunning.get()).toBe(true);
    });

    describe('A34: superseding a run suspended on a host call', () => {
      let answerHang: (value: unknown) => void;
      let hangCalls: number;
      // hangCap-style host call, held open until the test answers it.
      const hangCap: SandboxCapability = {
        name: 'hang',
        description: 'host call answered only by the test',
        stubInfo: { name: 'hang', type: 'function' },
        invokeHost: () => {
          hangCalls++;
          return new Promise((r) => (answerHang = r));
        },
      };
      const echoCap: SandboxCapability = {
        name: 'echo',
        description: 'host call that answers at once',
        stubInfo: { name: 'echo', type: 'function' },
        invokeHost: async (_method, args) => args[0],
      };

      beforeEach(() => {
        hangCalls = 0;
        registry.register(hangCap);
        registry.register(echoCap);
        registry.setEnabled('hang', true);
        registry.setEnabled('echo', true);
      });

      const capCall = (runId: number, callId: number, capability: string, args: unknown[] = []) =>
        ({ type: 'cap-call', callId, runId, capability, method: capability, args }) as const;
      const capResults = (w: FakeJsWorker) => w.posts.filter((m) => m.type === 'cap-result');

      it('A34: the old run settles as superseded and the new run starts on a fresh worker', async () => {
        await build();
        const pA = runner.execute('hang()', { tag: 'A' });
        await settle();
        const runA = workers[0].runs[0];
        workers[0].simulate(capCall(runA.runId, 1, 'hang'));
        await settle();
        expect(hangCalls).toBe(1);

        const pB = runner.execute('echo(1)', { tag: 'B' });
        const rA = await pA;
        expect(rA).toEqual(
          expect.objectContaining({ success: false, timedOut: false, error: SUPERSEDED }),
        );
        expect(workers[0].terminate).toHaveBeenCalledOnce();
        await settle();
        expect(workers).toHaveLength(2);
        expect(workers[1].runs.map((r) => r.code)).toEqual(['echo(1)']);
        expect(runner.activeTag.get()).toBe('B');
        const runB = workers[1].runs[0];
        workers[1].done(runB.runId);
        expect((await pB).success).toBe(true);
      });

      it("A34: no late cap-call, output or done from the old run reaches the new run", async () => {
        await build();
        const pA = runner.execute('hang()', { tag: 'A' });
        await settle();
        const runA = workers[0].runs[0];
        workers[0].simulate(capCall(runA.runId, 1, 'hang'));
        await settle();

        const pB = runner.execute('echo(7)', { tag: 'B' });
        const rA = await pA;
        await settle();
        const runB = workers[1].runs[0];
        const streamed: OutputEntry[] = [];
        const runs: (RunInfo | null)[] = [];
        runner.onOutput((e) => streamed.push(e));
        runner.onRun((r) => runs.push(r));

        // The old worker continues to send messages, as a stale worker can:
        // with its own runId, and with the new run's id.
        for (const runId of [runA.runId, runB.runId]) {
          workers[0].simulate({
            type: 'output',
            runId,
            entry: { type: 'log', content: `stale-${runId}`, timestamp: 1 },
          });
          workers[0].simulate(capCall(runId, 2, 'echo', ['stale']));
          workers[0].done(runId, { success: false, error: 'stale done' });
        }
        // The old run's id on the new worker is ignored too.
        workers[1].simulate({
          type: 'output',
          runId: runA.runId,
          entry: { type: 'log', content: 'stale-on-new', timestamp: 1 },
        });
        workers[1].simulate(capCall(runA.runId, 3, 'echo', ['stale']));
        workers[1].done(runA.runId, { success: false, error: 'stale done' });
        await settle();
        expect(streamed).toEqual([]);
        expect(runs).toEqual([]);
        expect(capResults(workers[1])).toEqual([]);
        expect(await state(pB)).toBe('pending');
        expect(runner.activeTag.get()).toBe('B');
        expect(hangCalls).toBe(1);

        // The new run's own call reuses callId 1 (ids restart per worker).
        workers[1].simulate(capCall(runB.runId, 1, 'echo', [7]));
        await settle();
        expect(capResults(workers[1])).toEqual([
          { type: 'cap-result', callId: 1, ok: true, value: 7 },
        ]);

        // The old run's pending host call finally answers: it is dropped,
        // never posted into the new worker as an answer to callId 1.
        answerHang('late');
        await settle();
        expect(capResults(workers[1])).toHaveLength(1);
        expect(capResults(workers[0])).toEqual([]);

        workers[1].simulate({
          type: 'output',
          runId: runB.runId,
          entry: { type: 'result', content: '7', timestamp: 2 },
        });
        workers[1].done(runB.runId);
        const rB = await pB;
        expect(rB.success).toBe(true);
        expect(rB.error).toBeUndefined();
        expect(rB.output.map((e) => e.content)).toEqual(['[hang, echo enabled]', '7']);
        expect(rA.output.map((e) => e.content)).toEqual(['[hang, echo enabled]', SUPERSEDED]);
        expect(streamed.map((e) => e.content)).toEqual(['7']);
      });

      it('A34: a run superseded while the fresh worker boots never starts', async () => {
        await build();
        const pA = runner.execute('hang()');
        await settle();
        const pB = runner.execute('b()');
        const pC = runner.execute('c()');
        expect((await pA).error).toBe(SUPERSEDED);
        const rB = await pB;
        expect(rB).toEqual(
          expect.objectContaining({ success: false, timedOut: false, error: SUPERSEDED }),
        );
        await settle();
        expect(workers).toHaveLength(2);
        expect(workers[1].runs.map((r) => r.code)).toEqual(['c()']);
        workers[1].done(workers[1].runs[0].runId);
        expect((await pC).success).toBe(true);
        expect(runner.isRunning.get()).toBe(false);
      });

      it('A34: isRunning clears when the fresh worker fails to boot', async () => {
        let bootOk = true;
        runner = new JsRunner(registry, {
          bootTimeoutMs: 50,
          workerFactory: () => {
            const w = new FakeJsWorker(bootOk);
            workers.push(w);
            return w as unknown as Worker;
          },
        });
        await runner.initialize();
        const pA = runner.execute('hang()');
        await settle();
        bootOk = false;
        const pB = runner.execute('b()');
        expect((await pA).error).toBe(SUPERSEDED);
        expect(runner.isRunning.get()).toBe(true);
        const rB = await pB;
        expect(rB.error).toBe('WASM module not initialized');
        expect(runner.isRunning.get()).toBe(false);
        expect(runner.initError.get()).toBe('JS worker did not become ready within 50 ms.');
        expect(workers[1].runs).toEqual([]);
      });
    });

    describe('A65: abort() while a supersede respawn is in flight', () => {
      const ABORTED = 'Execution aborted.';
      /** Per spawn: whether the fake worker reports ready by itself. */
      let autoReady: boolean[];

      async function buildManual(): Promise<void> {
        runner = new JsRunner(registry, {
          workerFactory: () => {
            const w = new FakeJsWorker(autoReady.shift() ?? true);
            workers.push(w);
            return w as unknown as Worker;
          },
        });
        await runner.initialize();
      }

      beforeEach(() => {
        autoReady = [];
      });

      it('A65: the superseding run settles as aborted and is never posted to the new worker', async () => {
        await buildManual();
        const pA = runner.execute('a()');
        await settle();
        autoReady.push(false);
        const pB = runner.execute('while (true) {}');
        expect((await pA).error).toBe(SUPERSEDED);
        expect(workers).toHaveLength(2);
        expect(runner.isRunning.get()).toBe(true);

        await runner.abort();
        expect(runner.isRunning.get()).toBe(false);
        expect(await state(pB)).toEqual({
          success: false,
          output: [{ type: 'system', content: ABORTED, timestamp: expect.any(Number) }],
          error: ABORTED,
          timedOut: false,
          durationMs: 0,
        });

        // The fresh worker comes up and is left idle: B never reaches it.
        workers[1].simulate({ type: 'ready' });
        await settle();
        expect(workers[1].runs).toEqual([]);
        expect(runner.isRunning.get()).toBe(false);
        expect(runner.activeTag.get()).toBeNull();
        expect(runner.ready.get()).toBe(true);

        // A later run still starts normally on that worker.
        const pC = runner.execute('c()');
        await settle();
        expect(workers[1].runs.map((r) => r.code)).toEqual(['c()']);
        workers[1].done(workers[1].runs[0].runId);
        expect((await pC).success).toBe(true);
      });

      it('A65: every run waiting on the respawn is cancelled, and abort() when idle stays a no-op', async () => {
        await buildManual();
        const pA = runner.execute('a()');
        await settle();
        autoReady.push(false);
        const pB = runner.execute('b()');
        const pC = runner.execute('c()');
        await pA;
        expect((await pB).error).toBe(SUPERSEDED);
        await runner.abort();
        expect((await state(pC)) as ExecutionResult).toEqual(
          expect.objectContaining({ success: false, error: ABORTED }),
        );
        workers[1].simulate({ type: 'ready' });
        await settle();
        expect(workers[1].runs).toEqual([]);
        await runner.abort();
        expect(workers[1].terminate).not.toHaveBeenCalled();
        expect(workers).toHaveLength(2);
      });

      it('A65: a run disposed during the respawn settles as aborted', async () => {
        await buildManual();
        const pA = runner.execute('a()');
        await settle();
        autoReady.push(false);
        const pB = runner.execute('b()');
        await pA;
        runner.dispose();
        expect((await state(pB)) as ExecutionResult).toEqual(
          expect.objectContaining({ success: false, timedOut: false, error: ABORTED }),
        );
        expect(workers[1].runs).toEqual([]);
      });

      it('A65: a supersede racing the respawn never orphans a spawn', async () => {
        await buildManual();
        const pA = runner.execute('a()');
        await settle();
        // B is posted when the respawned worker is ready. C supersedes it
        // immediately, before the bookkeeping of the first respawn runs.
        let pC: Promise<ExecutionResult> | undefined;
        runner.onRun((info) => {
          if (info?.tag === 'B' && !pC) {
            autoReady.push(false);
            pC = runner.execute('c()', { tag: 'C' });
          }
        });
        const pB = runner.execute('b()', { tag: 'B' });
        await pA;
        await settle();
        expect((await pB).error).toBe(SUPERSEDED);
        expect(workers).toHaveLength(3);
        expect(runner.isRunning.get()).toBe(true);

        // The third worker still boots. Neither initialize() nor a new run
        // can start another worker or fail as not initialized.
        const init = runner.initialize();
        const pD = runner.execute('d()', { tag: 'D' });
        await settle();
        expect(workers).toHaveLength(3);
        expect(await state(pD)).toBe('pending');
        expect(workers[2].runs).toEqual([]);

        workers[2].simulate({ type: 'ready' });
        await init;
        await settle();
        expect((await pC!).error).toBe(SUPERSEDED);
        expect(workers[2].runs.map((r) => r.code)).toEqual(['d()']);
        workers[2].done(workers[2].runs[0].runId);
        expect((await pD).success).toBe(true);
        expect(workers).toHaveLength(3);
      });

      it("A65: a replaced worker's late error event does not touch initError", async () => {
        await buildManual();
        const pA = runner.execute('a()');
        await settle();
        const pB = runner.execute('b()');
        await pA;
        await settle();
        workers[0].simulateError('stale worker error');
        expect(runner.initError.get()).toBeNull();
        workers[1].done(workers[1].runs[0].runId);
        await pB;
      });
    });
  });

  describe('time limit validation', () => {
    const BAD = [Infinity, -Infinity, NaN, 0, -1, 2_147_481_648, 2 ** 31, '5' as unknown as number];
    const BAD_BOOT = [Infinity, -Infinity, NaN, 0, -1, 2 ** 31, '5' as unknown as number];
    const factory = () => new FakeJsWorker() as unknown as Worker;

    it.each(BAD)('the constructor rejects timeoutMs %s', (timeoutMs) => {
      expect(() => new JsRunner(registry, { workerFactory: factory, timeoutMs })).toThrow(RangeError);
    });

    it.each(BAD_BOOT)('the constructor rejects bootTimeoutMs %s', (bootTimeoutMs) => {
      expect(() => new JsRunner(registry, { workerFactory: factory, bootTimeoutMs })).toThrow(
        RangeError,
      );
    });

    it('accepts the largest values that fit in a timer delay', () => {
      const r = new JsRunner(registry, {
        workerFactory: factory,
        timeoutMs: 2_147_481_647,
        bootTimeoutMs: 2_147_483_647,
      });
      expect(r.timeoutMs).toBe(2_147_481_647);
      r.dispose();
    });

    it.each(BAD)('the timeoutMs setter rejects %s and keeps the old value', async (value) => {
      await build({ timeoutMs: 1234 });
      expect(() => {
        runner.timeoutMs = value;
      }).toThrow(RangeError);
      expect(runner.timeoutMs).toBe(1234);
      runner.timeoutMs = 50;
      expect(runner.timeoutMs).toBe(50);
    });

    it.each(BAD)(
      'execute({ timeoutMs: %s }) settles as a failure, posts nothing and leaves the run in flight alone',
      async (timeoutMs) => {
        await build();
        const first = runner.execute('first()');
        await settle();
        const result = await runner.execute('bad()', { timeoutMs });
        expect(result.success).toBe(false);
        expect(result.timedOut).toBe(false);
        expect(result.error).toMatch(/^timeoutMs must be a finite number greater than 0/);
        expect(result.output).toEqual([
          expect.objectContaining({ type: 'system', content: result.error }),
        ]);
        expect(workers).toHaveLength(1);
        expect(current().runs.map((r) => r.code)).toEqual(['first()']);
        expect(runner.isRunning.get()).toBe(true);
        current().done(current().runs[0].runId);
        expect((await first).success).toBe(true);
      },
    );

    it('an invalid per-run timeoutMs never arms a backstop that fires at once', async () => {
      await build();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p = runner.execute('x()', { timeoutMs: Infinity });
      vi.advanceTimersByTime(1);
      expect((await p).timedOut).toBe(false);
      expect(workers[0].terminate).not.toHaveBeenCalled();
    });
  });

  describe("concurrency: 'queue'", () => {
    it('runs each execute() after the previous one settles, in call order', async () => {
      await build({ concurrency: 'queue' });
      const p1 = runner.execute('one');
      const p2 = runner.execute('two');
      const p3 = runner.execute('three');
      await settle();
      expect(current().runs.map((r) => r.code)).toEqual(['one']);
      expect(runner.queued.get()).toBe(2);

      current().done(current().runs[0].runId);
      await settle();
      expect(current().runs.map((r) => r.code)).toEqual(['one', 'two']);
      expect(runner.queued.get()).toBe(1);
      expect(await state(p3)).toBe('pending');

      current().done(current().runs[1].runId, { success: false, error: 'Error: boom' });
      await settle();
      expect(current().runs.map((r) => r.code)).toEqual(['one', 'two', 'three']);
      current().done(current().runs[2].runId);

      const results = await Promise.all([p1, p2, p3]);
      expect(results.map((r) => r.success)).toEqual([true, false, true]);
      expect(runner.queued.get()).toBe(0);
    });

    it('abort() ends only the run in flight; the queued run starts on the respawned worker', async () => {
      await build({ concurrency: 'queue' });
      const p1 = runner.execute('hang()');
      const p2 = runner.execute('after()');
      await settle();
      expect(workers).toHaveLength(1);

      await runner.abort();
      const r1 = await p1;
      expect(r1.success).toBe(false);
      expect(r1.error).toBe('Execution aborted.');
      expect(workers[0].terminate).toHaveBeenCalled();

      await settle();
      expect(workers).toHaveLength(2);
      expect(workers[0].runs).toHaveLength(1);
      expect(workers[1].runs.map((r) => r.code)).toEqual(['after()']);
      workers[1].done(workers[1].runs[0].runId);
      expect((await p2).success).toBe(true);
      expect(runner.queued.get()).toBe(0);
    });

    it('a backstop timeout in the chain does not stall later runs', async () => {
      await build({ concurrency: 'queue' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p1 = runner.execute('stuck()', { timeoutMs: 10 });
      const p2 = runner.execute('next()');
      await state(Promise.resolve());
      vi.advanceTimersByTime(10 + 2000);
      const r1 = await p1;
      expect(r1.timedOut).toBe(true);
      vi.useRealTimers();
      await settle();
      // The stuck worker is replaced, and the next run goes to the new one.
      expect(workers).toHaveLength(2);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(workers[0].runs.map((r) => r.code)).toEqual(['stuck()']);
      expect(workers[1].runs.map((r) => r.code)).toEqual(['next()']);
      workers[1].done(workers[1].runs[0].runId);
      expect((await p2).success).toBe(true);
    });
  });

  describe('per-run options', () => {
    it('keeps the default timeout and an empty tag when no options are passed', async () => {
      await build({ timeoutMs: 1234 });
      void runner.execute('x');
      await settle();
      expect(current().runs[0].timeoutMs).toBe(1234);
      expect(runner.activeTag.get()).toBe('');
    });

    it('timeoutMs overrides the default for that run only (worker deadline and backstop)', async () => {
      await build({ timeoutMs: 5000 });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p = runner.execute('stuck()', { timeoutMs: 50 });
      await state(Promise.resolve());
      expect(current().runs[0].timeoutMs).toBe(50);
      vi.advanceTimersByTime(50 + 1999);
      expect(await state(p)).toBe('pending');
      vi.advanceTimersByTime(1);
      expect((await p).timedOut).toBe(true);
      vi.useRealTimers();

      await settle();
      void runner.execute('again()');
      await settle();
      expect(current().runs[0].timeoutMs).toBe(5000);
    });

    it('activeTag is the run tag while a host capability runs, and null after', async () => {
      const seen: (string | null)[] = [];
      const whoami: SandboxCapability = {
        name: 'whoami',
        description: 'reports the caller',
        stubInfo: { name: 'whoami', type: 'function' },
        invokeHost: async () => {
          seen.push(runner.activeTag.get());
          return 'ok';
        },
      };
      registry.register(whoami);
      registry.setEnabled('whoami', true);
      await build();
      expect(runner.activeTag.get()).toBeNull();

      const p = runner.execute('whoami()', { tag: 'claude' });
      await settle();
      const { runId } = current().runs[0];
      current().simulate({
        type: 'cap-call',
        callId: 1,
        runId,
        capability: 'whoami',
        method: 'whoami',
        args: [],
      });
      await settle();
      expect(seen).toEqual(['claude']);
      expect(current().posts).toContainEqual({
        type: 'cap-result',
        callId: 1,
        ok: true,
        value: 'ok',
      });

      current().done(runId);
      await p;
      expect(runner.activeTag.get()).toBeNull();
    });

    it('activeTag resets to null on abort', async () => {
      await build();
      const tags: (string | null)[] = [];
      runner.activeTag.subscribe((t) => tags.push(t));
      const p = runner.execute('hang()', { tag: 'event' });
      await settle();
      await runner.abort();
      await p;
      expect(tags).toEqual(['event', null]);
    });
  });

  describe('onRun', () => {
    let events: (RunInfo | null)[];

    beforeEach(async () => {
      await build({ timeoutMs: 300 });
      events = [];
      runner.onRun((e) => events.push(e));
    });

    it('fires with the run info at start and null when it finishes', async () => {
      const p = runner.execute('x', { tag: 'handler', timeoutMs: 40 });
      await settle();
      expect(events).toEqual([{ tag: 'handler', startTime: expect.any(Number), timeoutMs: 40 }]);
      current().done(current().runs[0].runId);
      await p;
      expect(events).toHaveLength(2);
      expect(events[1]).toBeNull();
    });

    it('fires null on a backstop timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const p = runner.execute('stuck()');
      await state(Promise.resolve());
      expect(events).toEqual([{ tag: '', startTime: expect.any(Number), timeoutMs: 300 }]);
      vi.advanceTimersByTime(300 + 2000);
      await p;
      expect(events[1]).toBeNull();
    });

    it('fires null on a worker-reported timeout and on abort', async () => {
      const p1 = runner.execute('loop()');
      await settle();
      current().done(current().runs[0].runId, {
        success: false,
        timedOut: true,
        error: 'timed out',
      });
      await p1;
      const p2 = runner.execute('hang()');
      await settle();
      await runner.abort();
      await p2;
      expect(events.map((e) => (e === null ? null : 'start'))).toEqual([
        'start',
        null,
        'start',
        null,
      ]);
    });

    it('stops firing after unsubscribe', async () => {
      const seen: unknown[] = [];
      const off = runner.onRun((e) => seen.push(e));
      off();
      const p = runner.execute('x');
      await settle();
      current().done(current().runs[0].runId);
      await p;
      expect(seen).toEqual([]);
    });
  });

  describe('onOutput', () => {
    it('streams each entry as the worker posts it, matching the result output', async () => {
      await build();
      const streamed: OutputEntry[] = [];
      runner.onOutput((e) => streamed.push(e));
      const p = runner.execute('console.log("a"); console.log("b")');
      await settle();
      expect(streamed).toEqual([
        expect.objectContaining({ type: 'system', content: '[no capabilities enabled]' }),
      ]);
      const { runId } = current().runs[0];
      const entry = (content: string): OutputEntry => ({ type: 'log', content, timestamp: 1 });
      current().simulate({ type: 'output', runId, entry: entry('a') });
      expect(streamed.at(-1)).toEqual(entry('a'));
      // Stale run ids (a killed run's worker) are dropped, not streamed.
      current().simulate({ type: 'output', runId: runId + 99, entry: entry('stale') });
      current().simulate({ type: 'output', runId, entry: entry('b') });
      expect(streamed.map((e) => e.content)).toEqual(['[no capabilities enabled]', 'a', 'b']);
      current().done(runId);
      expect((await p).output).toEqual(streamed);
    });

    it('streams the abort entry', async () => {
      await build();
      const streamed: OutputEntry[] = [];
      runner.onOutput((e) => streamed.push(e));
      const p = runner.execute('hang()');
      await settle();
      await runner.abort();
      const result = await p;
      expect(streamed.at(-1)).toEqual(expect.objectContaining({ content: 'Execution aborted.' }));
      expect(result.output).toEqual(streamed);
    });
  });

  describe('recycleAfterRuns', () => {
    it('is off by default', async () => {
      await build();
      for (let i = 0; i < 10; i++) {
        const p = runner.execute(`run${i}`);
        await settle();
        current().done(current().runs[i].runId);
        await p;
      }
      expect(workers).toHaveLength(1);
    });

    it('replaces the worker between runs after N runs and reports "periodic"', async () => {
      await build({ recycleAfterRuns: 2 });
      const reasons: string[] = [];
      runner.onRecycle((r) => reasons.push(r));
      for (let i = 0; i < 2; i++) {
        const p = runner.execute(`run${i}`);
        await settle();
        current().done(current().runs[i].runId);
        await p;
      }
      expect(workers).toHaveLength(1);
      expect(reasons).toEqual([]);

      const p3 = runner.execute('run2');
      await settle();
      expect(reasons).toEqual(['periodic']);
      expect(workers).toHaveLength(2);
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(workers[1].runs.map((r) => r.code)).toEqual(['run2']);
      workers[1].done(workers[1].runs[0].runId);
      expect((await p3).success).toBe(true);
    });

    it('counts runs from the latest spawn (an abort resets the count)', async () => {
      await build({ recycleAfterRuns: 2 });
      const reasons: string[] = [];
      runner.onRecycle((r) => reasons.push(r));
      const p1 = runner.execute('one');
      await settle();
      current().done(current().runs[0].runId);
      await p1;
      const p2 = runner.execute('hang()');
      await settle();
      await runner.abort();
      await p2;
      const p3 = runner.execute('three');
      await settle();
      expect(reasons).toEqual([]);
      expect(workers).toHaveLength(2);
      current().done(current().runs[0].runId);
      await p3;
    });
  });

  describe('heap-exhaustion recovery', () => {
    it('respawns the worker and retries the run once', async () => {
      await build();
      const reasons: string[] = [];
      const events: (RunInfo | null)[] = [];
      runner.onRecycle((r) => reasons.push(r));
      runner.onRun((e) => events.push(e));
      const p = runner.execute('big()', { tag: 't', timeoutMs: 99 });
      await settle();
      workers[0].done(workers[0].runs[0].runId, { success: false, error: OOM, exhausted: true });
      await settle();

      expect(reasons).toEqual([OOM]);
      expect(workers).toHaveLength(2);
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(workers[1].runs).toEqual([expect.objectContaining({ code: 'big()', timeoutMs: 99 })]);
      expect(runner.activeTag.get()).toBe('t');
      workers[1].done(workers[1].runs[0].runId);
      const result = await p;
      expect(result.success).toBe(true);
      expect(events.map((e) => (e === null ? null : e.tag))).toEqual(['t', null, 't', null]);
    });

    it('gives up after one retry and returns the failure', async () => {
      await build();
      const reasons: string[] = [];
      runner.onRecycle((r) => reasons.push(r));
      const p = runner.execute('big()');
      await settle();
      workers[0].done(workers[0].runs[0].runId, { success: false, error: OOM, exhausted: true });
      await settle();
      workers[1].done(workers[1].runs[0].runId, {
        success: false,
        error: "capability 'd3' setup failed: {}",
        exhausted: true,
      });
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toContain('setup failed');
      // The spent worker is still replaced, so the next run starts clean.
      expect(reasons).toHaveLength(2);
      await settle();
      expect(workers).toHaveLength(3);
      expect(workers[2].runs).toEqual([]);
    });

    it.each<[string, NonNullable<Parameters<FakeJsWorker['done']>[1]>]>([
      ['an ordinary error', { success: false, error: 'TypeError: nope' }],
      ['a timeout', { success: false, timedOut: true, error: 'InternalError: interrupted' }],
      ['exhausted on a successful run', { success: true, exhausted: true }],
      [
        'exhausted on a timed-out run',
        {
          success: false,
          timedOut: true,
          error: 'Execution timed out: script exceeded the time limit.',
          exhausted: true,
        },
      ],
    ])('does not respawn or retry on %s', async (_, extra) => {
      await build();
      const reasons: string[] = [];
      runner.onRecycle((r) => reasons.push(r));
      const p = runner.execute('x()');
      await settle();
      current().done(current().runs[0].runId, extra);
      const result = await p;
      expect(result.success).toBe(extra.success);
      expect(result.timedOut).toBe(extra.timedOut ?? false);
      expect(result.error).toBe(extra.error);
      await settle();
      expect(reasons).toEqual([]);
      expect(workers).toHaveLength(1);
      expect(workers[0].runs).toHaveLength(1);
    });

    it.each([
      OOM,
      'Error: out of memory',
      "capability 'd3' setup failed: {}",
      'InternalError: stack overflow',
    ])('does not retry an error with the text %j when the worker does not set exhausted', async (error) => {
      await build();
      const reasons: string[] = [];
      runner.onRecycle((r) => reasons.push(r));
      const p = runner.execute('throwIt()');
      await settle();
      current().done(current().runs[0].runId, { success: false, error });
      const result = await p;
      expect(result.error).toBe(error);
      expect(reasons).toEqual([]);
      expect(workers).toHaveLength(1);
      expect(workers[0].runs).toHaveLength(1);
    });

    it('can be disabled with recoverExhaustion: false', async () => {
      await build({ recoverExhaustion: false });
      const reasons: string[] = [];
      runner.onRecycle((r) => reasons.push(r));
      const p = runner.execute('big()');
      await settle();
      current().done(current().runs[0].runId, { success: false, error: OOM, exhausted: true });
      const result: ExecutionResult = await p;
      expect(result.error).toBe(OOM);
      expect(reasons).toEqual([]);
      expect(workers).toHaveLength(1);
    });
  });
});

// The worker is untrusted: every worker→host message is shape-checked on
// the host, during boot and during runs. FakeJsWorker throws listener
// exceptions again. Thus each simulateRaw() call that returns normally
// checks "ignored without throwing".
describe('JsRunner worker message validation', () => {
  let registry: CapabilityStore;
  let workers: FakeJsWorker[];
  let runner: JsRunner;

  async function build(autoReady = true): Promise<JsRunner> {
    runner = new JsRunner(registry, {
      workerFactory: () => {
        const w = new FakeJsWorker(autoReady);
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    if (autoReady) await runner.initialize();
    return runner;
  }

  const current = () => workers[workers.length - 1];

  /** Starts a run and returns its promise and runId. */
  async function start(code = 'x'): Promise<{ p: Promise<ExecutionResult>; runId: number }> {
    const p = runner.execute(code);
    await settle();
    return { p, runId: current().runs.at(-1)!.runId };
  }

  const NOT_OBJECTS: unknown[] = [null, undefined, 'done', 42, true, [], [{ type: 'ready' }], {}];

  beforeEach(() => {
    registry = new CapabilityStore();
    workers = [];
  });

  afterEach(() => {
    runner?.dispose();
  });

  describe('A28: non-object messages', () => {
    it('A28: ignores null, primitives, arrays and objects without type during boot', async () => {
      await build(false);
      const init = runner.initialize();
      for (const data of NOT_OBJECTS) current().simulateRaw(data);
      expect(await state(init)).toBe('pending');
      current().simulate({ type: 'ready' });
      await init;
      expect(runner.ready.get()).toBe(true);
    });

    it('A28: ignores them during a run, which then completes normally', async () => {
      await build();
      const { p, runId } = await start();
      for (const data of NOT_OBJECTS) current().simulateRaw(data);
      expect(await state(p)).toBe('pending');
      current().done(runId);
      expect((await p).success).toBe(true);
    });

    it('A28: a malformed init-error does not fail boot', async () => {
      await build(false);
      const init = runner.initialize();
      current().simulateRaw({ type: 'init-error', message: 42 });
      current().simulateRaw({ type: 'init-error' });
      expect(await state(init)).toBe('pending');
      current().simulate({ type: 'ready' });
      await init;
      expect(runner.initError.get()).toBeNull();
    });
  });

  describe('A24: unknown message types', () => {
    it('A24: ignores an unknown type and the in-flight run still completes normally', async () => {
      await build();
      const streamed: OutputEntry[] = [];
      runner.onOutput((e) => streamed.push(e));
      const { p, runId } = await start();
      current().simulateRaw({ type: 'pwn', runId });
      current().simulateRaw({ type: 'toString', runId });
      current().simulateRaw({ type: 42, runId });
      expect(await state(p)).toBe('pending');
      current().simulate({
        type: 'output',
        runId,
        entry: { type: 'log', content: 'ok', timestamp: 1 },
      });
      current().done(runId);
      const result = await p;
      expect(result.success).toBe(true);
      expect(result.output.map((e) => e.content)).toEqual(['[no capabilities enabled]', 'ok']);
      expect(streamed).toEqual(result.output);
    });

    it('A24: ignores an unknown type during boot', async () => {
      await build(false);
      const init = runner.initialize();
      current().simulateRaw({ type: 'pwn' });
      expect(await state(init)).toBe('pending');
      current().simulate({ type: 'ready' });
      await init;
      expect(runner.ready.get()).toBe(true);
    });
  });

  describe('A25: malformed output entries', () => {
    const BAD_ENTRIES: unknown[] = [
      undefined,
      null,
      'log',
      [],
      { content: 'no type', timestamp: 1 },
      { type: 'shout', content: 'unknown type', timestamp: 1 },
      { type: 'log', content: 42, timestamp: 1 },
      { type: 'log', content: { toString: () => 'x' }, timestamp: 1 },
      { type: 'log', timestamp: 1 },
      { type: 'log', content: 'no timestamp' },
    ];

    it('A25: drops an output whose entry is missing, has an unknown type or non-string content', async () => {
      await build();
      const streamed: OutputEntry[] = [];
      runner.onOutput((e) => streamed.push(e));
      const { p, runId } = await start();
      streamed.length = 0;
      for (const entry of BAD_ENTRIES) current().simulateRaw({ type: 'output', runId, entry });
      current().simulateRaw({
        type: 'output',
        runId: String(runId),
        entry: { type: 'log', content: 'string runId', timestamp: 1 },
      });
      expect(streamed).toEqual([]);
      current().simulate({
        type: 'output',
        runId,
        entry: { type: 'warn', content: 'good', timestamp: 2 },
      });
      current().done(runId);
      const result = await p;
      expect(streamed).toEqual([{ type: 'warn', content: 'good', timestamp: 2 }]);
      expect(result.output.map((e) => e.content)).toEqual(['[no capabilities enabled]', 'good']);
    });

    it('A25: passes on only the known entry fields', async () => {
      await build();
      const streamed: OutputEntry[] = [];
      runner.onOutput((e) => streamed.push(e));
      const { p, runId } = await start();
      current().simulateRaw({
        type: 'output',
        runId,
        entry: { type: 'log', content: 'hi', timestamp: 3, html: '<img onerror=x>' },
      });
      current().done(runId);
      await p;
      expect(streamed.at(-1)).toStrictEqual({ type: 'log', content: 'hi', timestamp: 3 });
    });
  });

  describe('A26: malformed cap-call', () => {
    let invokeHost: ReturnType<typeof vi.fn<(method: string, args: unknown[]) => Promise<unknown>>>;

    beforeEach(() => {
      invokeHost = vi.fn(
        async (_method: string, _args: unknown[]): Promise<unknown> => 'host value',
      );
      registry.register({
        name: 'echo',
        description: 'host-backed',
        stubInfo: { name: 'echo', type: 'object', methods: ['call', 'get'] },
        invokeHost,
      });
      registry.register({
        name: 'off',
        description: 'host-backed but disabled',
        stubInfo: { name: 'off', type: 'function' },
        invokeHost,
      });
      registry.setEnabled('echo', true);
    });

    const capResults = () => current().posts.filter((m) => m.type === 'cap-result');

    function call(runId: number, over: Record<string, unknown>): void {
      current().simulateRaw({
        type: 'cap-call',
        callId: 1,
        runId,
        capability: 'echo',
        method: 'call',
        args: [],
        ...over,
      });
    }

    it.each([
      ['non-array args', { callId: 11, args: 'nope' }],
      ['missing args', { callId: 12, args: undefined }],
      ['non-string method', { callId: 13, method: 7 }],
      ['non-string capability', { callId: 14, capability: ['echo'] }],
      ['unknown capability', { callId: 15, capability: 'nope' }],
      ['disabled capability', { callId: 16, capability: 'off' }],
      ['inherited property as capability', { callId: 17, capability: 'constructor' }],
    ])('A26: %s never reaches invokeHost and gets an error cap-result', async (_, over) => {
      await build();
      const { p, runId } = await start();
      call(runId, over);
      await settle();
      expect(invokeHost).not.toHaveBeenCalled();
      expect(capResults()).toEqual([
        { type: 'cap-result', callId: over.callId, ok: false, error: expect.any(String) },
      ]);
      current().done(runId);
      expect((await p).success).toBe(true);
    });

    it.each([
      ['string callId', { callId: '1' }],
      ['missing callId', { callId: undefined }],
      ['NaN callId', { callId: Number.NaN }],
      ['non-numeric callId with bad args', { callId: null, args: 'nope' }],
    ])('A26: %s never reaches invokeHost and gets no reply', async (_, over) => {
      await build();
      const { p, runId } = await start();
      call(runId, over);
      await settle();
      expect(invokeHost).not.toHaveBeenCalled();
      expect(capResults()).toEqual([]);
      current().done(runId);
      expect((await p).success).toBe(true);
    });

    it('A26: checks the host enabled set at call time, not the worker claim', async () => {
      await build();
      const { p, runId } = await start();
      registry.setEnabled('echo', false);
      call(runId, { callId: 21 });
      await settle();
      expect(invokeHost).not.toHaveBeenCalled();
      expect(capResults()).toEqual([
        { type: 'cap-result', callId: 21, ok: false, error: expect.stringContaining('echo') },
      ]);
      current().done(runId);
      await p;
    });

    it('A26: a well-formed call to an enabled capability still reaches invokeHost', async () => {
      await build();
      const { p, runId } = await start();
      call(runId, { callId: 31, method: 'get', args: [1, 'a'] });
      await settle();
      expect(invokeHost).toHaveBeenCalledWith('get', [1, 'a']);
      expect(capResults()).toEqual([
        { type: 'cap-result', callId: 31, ok: true, value: 'host value' },
      ]);
      current().done(runId);
      await p;
    });

    it('A26: a malformed call for a stale run gets no reply', async () => {
      await build();
      const { p, runId } = await start();
      call(runId + 99, { callId: 41, args: 'nope' });
      await settle();
      expect(invokeHost).not.toHaveBeenCalled();
      expect(capResults()).toEqual([]);
      current().done(runId);
      await p;
    });
  });

  describe('A67: cap-call methods are checked against the declared stub', () => {
    let invokeHost: ReturnType<typeof vi.fn<(method: string, args: unknown[]) => Promise<unknown>>>;

    beforeEach(() => {
      invokeHost = vi.fn(async (method: string): Promise<unknown> => `host ${method}`);
      registry.register({
        name: 'store',
        description: 'object capability',
        stubInfo: { name: 'store', type: 'object', methods: ['getItem', 'setItem'] },
        invokeHost,
      });
      registry.register({
        name: 'echo',
        description: 'function capability',
        stubInfo: { name: 'echo', type: 'function' },
        invokeHost,
      });
      registry.register({
        name: 'clock',
        description: 'function capability with globals',
        stubInfo: { name: 'clock', type: 'function', globals: ['now', 'sleep'] },
        invokeHost,
      });
      registry.register({
        name: 'bare',
        description: 'object capability without methods',
        stubInfo: { name: 'bare', type: 'object' },
        invokeHost,
      });
      for (const name of ['store', 'echo', 'clock', 'bare']) registry.setEnabled(name, true);
    });

    const capResults = () => current().posts.filter((m) => m.type === 'cap-result');

    /** Runs `body` with a spy on the process `unhandledRejection` event, then removes the spy. */
    async function withUnhandledSpy(
      body: (unhandled: ReturnType<typeof vi.fn>) => Promise<void>,
    ): Promise<void> {
      const unhandled = vi.fn();
      const proc = (
        globalThis as {
          process?: { on(e: string, fn: () => void): void; off(e: string, fn: () => void): void };
        }
      ).process;
      proc?.on('unhandledRejection', unhandled);
      try {
        await body(unhandled);
      } finally {
        proc?.off('unhandledRejection', unhandled);
      }
    }

    const capCall = (runId: number, callId: number, capability: string, method: string) => ({
      type: 'cap-call' as const,
      callId,
      runId,
      capability,
      method,
      args: [],
    });

    it.each([
      ['an undeclared object method', 'store', 'clear'],
      ['the object capability name itself', 'store', 'store'],
      ['an inherited name', 'store', 'constructor'],
      ['__proto__', 'store', '__proto__'],
      ['toString', 'echo', 'toString'],
      ['another name on a function capability', 'echo', 'call'],
      ['the name of a function capability that declares globals', 'clock', 'clock'],
      ['any method of an object capability that declares none', 'bare', 'bare'],
      ['a method declared by another capability', 'echo', 'getItem'],
    ])('A67: %s never reaches invokeHost and gets an error cap-result', async (_, cap, method) => {
      await build();
      const { p, runId } = await start();
      current().simulate(capCall(runId, 5, cap, method));
      await settle();
      expect(invokeHost).not.toHaveBeenCalled();
      expect(capResults()).toEqual([
        { type: 'cap-result', callId: 5, ok: false, error: expect.stringContaining(method) },
      ]);
      current().done(runId);
      expect((await p).success).toBe(true);
    });

    it.each([
      ['a declared object method', 'store', 'setItem'],
      ['the function capability name', 'echo', 'echo'],
      ['a declared global', 'clock', 'sleep'],
    ])('A67: %s reaches invokeHost', async (_, cap, method) => {
      await build();
      const { p, runId } = await start();
      current().simulate(capCall(runId, 6, cap, method));
      await settle();
      expect(invokeHost).toHaveBeenCalledExactlyOnceWith(method, []);
      expect(capResults()).toEqual([
        { type: 'cap-result', callId: 6, ok: true, value: `host ${method}` },
      ]);
      current().done(runId);
      await p;
    });

    it('A67: an un-cloneable host result is answered with an error cap-result', async () => {
      await build();
      const { p, runId } = await start();
      await withUnhandledSpy(async (unhandled) => {
        current().postMessage.mockImplementationOnce(() => {
          throw new DOMException('() => 1 could not be cloned.', 'DataCloneError');
        });
        current().simulate(capCall(runId, 7, 'echo', 'echo'));
        await settle();
        await settle();
        expect(capResults()).toEqual([
          {
            type: 'cap-result',
            callId: 7,
            ok: false,
            error: expect.stringContaining('could not be cloned'),
          },
        ]);
        expect(unhandled).not.toHaveBeenCalled();
      });
      current().done(runId);
      expect((await p).success).toBe(true);
    });

    it('A67: a fallback error reply that also throws is not an unhandled rejection', async () => {
      await build();
      const { p, runId } = await start();
      await withUnhandledSpy(async (unhandled) => {
        // Both the result and the error reply fail to post.
        current().postMessage.mockImplementation(() => {
          throw new DOMException('the port is closed', 'InvalidStateError');
        });
        current().simulate(capCall(runId, 8, 'echo', 'echo'));
        await settle();
        await settle();
        expect(current().postMessage).toHaveBeenCalledTimes(3); // run, result, error reply
        expect(unhandled).not.toHaveBeenCalled();
      });
      current().done(runId);
      expect((await p).success).toBe(true);
    });
  });

  describe('A27: done for the wrong run or with a bad shape', () => {
    it.each([
      ['non-boolean success', (runId: number) => ({ runId, success: 'yes', timedOut: false })],
      ['missing success', (runId: number) => ({ runId, timedOut: false })],
      ['non-boolean timedOut', (runId: number) => ({ runId, success: true, timedOut: 0 })],
      [
        'non-string error',
        (runId: number) => ({ runId, success: false, timedOut: false, error: {} }),
      ],
      [
        'string runId',
        (runId: number) => ({ runId: String(runId), success: true, timedOut: false }),
      ],
      ['another runId', (runId: number) => ({ runId: runId + 1, success: true, timedOut: false })],
      [
        'an earlier runId',
        (runId: number) => ({ runId: runId - 1, success: true, timedOut: false }),
      ],
    ])('A27: %s does not settle the active run', async (_, make) => {
      await build();
      const { p, runId } = await start();
      current().simulateRaw({ type: 'done', ...make(runId) });
      expect(await state(p)).toBe('pending');
      expect(runner.isRunning.get()).toBe(true);
      current().done(runId, { success: false, error: 'Error: real' });
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Error: real');
    });
  });
});

describe('JsRunner boot timeout', () => {
  let workers: FakeJsWorker[];
  let readyOnBoot: boolean[];
  let runner: JsRunner;

  function build(options: Omit<JsRunnerOptions, 'workerFactory'> = {}): JsRunner {
    runner = new JsRunner(new CapabilityStore(), {
      ...options,
      workerFactory: () => {
        const w = new FakeJsWorker(readyOnBoot.shift() ?? false);
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    return runner;
  }

  beforeEach(() => {
    workers = [];
    readyOnBoot = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    runner?.dispose();
    vi.useRealTimers();
  });

  it('rejects initialize(), sets initError and terminates a worker that never posts ready', async () => {
    build({ bootTimeoutMs: 1000 });
    const booted = runner.initialize();
    const outcome = booted.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    vi.advanceTimersByTime(999);
    expect(await state(outcome)).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await state(outcome)).toBe('JS worker did not become ready within 1000 ms.');
    expect(runner.initError.get()).toBe('JS worker did not become ready within 1000 ms.');
    expect(runner.ready.get()).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it('defaults to 30 s', async () => {
    build();
    const outcome = runner.initialize().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    vi.advanceTimersByTime(29_999);
    expect(await state(outcome)).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await state(outcome)).toMatch(/within 30000 ms/);
  });

  it('a late ready is ignored, and a retry boots a fresh worker', async () => {
    build({ bootTimeoutMs: 1000 });
    const first = runner.initialize().catch(() => undefined);
    vi.advanceTimersByTime(1000);
    await first;
    workers[0].simulate({ type: 'ready' });
    expect(runner.ready.get()).toBe(false);

    readyOnBoot.push(true);
    await runner.initialize();
    expect(workers).toHaveLength(2);
    expect(runner.ready.get()).toBe(true);
    expect(runner.initError.get()).toBeNull();
  });

  it('a timely ready clears the timer', async () => {
    readyOnBoot.push(true);
    build({ bootTimeoutMs: 1000 });
    await runner.initialize();
    // A late boot timer has no visible effect on a settled boot. Thus
    // only the timer count shows that the timer was cleared.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(runner.ready.get()).toBe(true);
    expect(runner.initError.get()).toBeNull();
    expect(workers[0].terminate).not.toHaveBeenCalled();
  });

  it('dispose() during a boot clears the boot timer; initialize() resolves', async () => {
    build({ bootTimeoutMs: 1000 });
    const outcome = runner.initialize().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(vi.getTimerCount()).toBe(1);
    runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(await state(outcome)).toBe('resolved');
    expect(runner.ready.get()).toBe(false);
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it('dispose() during a respawn clears its boot timer', async () => {
    readyOnBoot.push(true);
    build({ bootTimeoutMs: 1000 });
    await runner.initialize();
    void runner.execute('while (true) {}');
    await state(Promise.resolve());
    await runner.abort();
    expect(workers).toHaveLength(2);
    runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    await state(Promise.resolve());
    expect(workers[1].terminate).toHaveBeenCalled();
    expect(runner.initError.get()).toBeNull();
  });

  it('applies to the respawn after an abort too', async () => {
    readyOnBoot.push(true);
    build({ bootTimeoutMs: 1000 });
    await runner.initialize();
    void runner.execute('while (true) {}');
    await state(Promise.resolve());
    await runner.abort();
    expect(workers).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    await state(Promise.resolve());
    expect(runner.initError.get()).toBe('JS worker did not become ready within 1000 ms.');
    expect(workers[1].terminate).toHaveBeenCalled();
  });
});
