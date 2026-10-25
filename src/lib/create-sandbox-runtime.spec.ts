import { vi } from 'vitest';
import {
  createSandboxRuntime,
  type SandboxRuntime,
  type SandboxRuntimeOptions,
} from './create-sandbox-runtime.js';
import type { JsMainToWorkerMsg, JsWorkerToMainMsg } from './js/worker-protocol.js';
import type { CodeRunner } from './shared/code-runner.js';
import { createValue } from './shared/readable-value.js';
import type { OutputEntry } from './shared/sandbox-types.js';

/** Minimal fake QuickJS worker: answers 'ready' on demand, records posts. */
class FakeJsWorker extends EventTarget {
  readonly posted: JsMainToWorkerMsg[] = [];
  postMessage = vi.fn((msg: JsMainToWorkerMsg) => this.posted.push(msg));
  terminate = vi.fn();
  simulate(msg: JsWorkerToMainMsg): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
}

/** Fake extra runner: always ready, answers every execute() with one entry. */
function fakeRunner(content = 'fake ran'): CodeRunner {
  const entry: OutputEntry = { type: 'system', content, timestamp: 0 };
  return {
    label: 'Fake',
    ready: createValue(true).asReadonly(),
    isRunning: createValue(false).asReadonly(),
    initError: createValue<string | null>(null).asReadonly(),
    activeTag: createValue<string | null>(null).asReadonly(),
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({ success: true, output: [entry], timedOut: false, durationMs: 0 }),
    abort: vi.fn().mockResolvedValue(undefined),
    onOutput: () => () => undefined,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createSandboxRuntime', () => {
  let jsWorker: FakeJsWorker;
  let jsWorkerFactory: ReturnType<typeof vi.fn<() => Worker>>;

  // Every runtime that a test builds. afterEach disposes them, also when a
  // test fails before its own dispose() call.
  let created: SandboxRuntime[];

  beforeEach(() => {
    jsWorker = new FakeJsWorker();
    jsWorkerFactory = vi.fn(() => jsWorker as unknown as Worker);
    created = [];
  });

  afterEach(() => {
    for (const rt of created) rt.dispose();
    vi.useRealTimers();
  });

  function create(options: SandboxRuntimeOptions): SandboxRuntime {
    const rt = createSandboxRuntime(options);
    created.push(rt);
    return rt;
  }

  function build() {
    return create({
      corsProxyUrl: '',
      jsWorkerFactory,
      timeoutMs: 1234,
    });
  }

  /** Makes the factory return a new fake worker for each spawn. */
  function spawnEach(): FakeJsWorker[] {
    const spawned: FakeJsWorker[] = [];
    jsWorkerFactory.mockImplementation(() => {
      const w = new FakeJsWorker();
      spawned.push(w);
      return w as unknown as Worker;
    });
    return spawned;
  }

  it('passes corsProxyUrl to the shared auth and starts the facade in js mode', () => {
    const rt = build();
    expect(rt.auth.proxyBase()).toBe('');
    expect(rt.facade.mode.get()).toBe('js');
    const remote = create({ jsWorkerFactory, corsProxyUrl: 'https://proxy.example' });
    expect(remote.auth.proxyBase()).toBe('https://proxy.example');
    expect(remote.auth).not.toBe(rt.auth);
  });

  it('registers only a js runner by default', () => {
    const rt = build();
    expect(rt.facade.modes).toEqual(['js']);
    expect(rt.facade.runner('js')).toBe(rt.js);
    expect(() => rt.facade.setMode('text')).toThrow(/Unknown mode "text"/);
    expect(rt.facade.mode.get()).toBe('js');
  });

  it('extra runners are registered under their keys and reachable via setMode', async () => {
    const foo = fakeRunner();
    const rt = create({ jsWorkerFactory, runners: { foo } });
    expect(rt.facade.modes).toEqual(['js', 'foo']);
    expect(rt.facade.runner('foo')).toBe(foo);
    rt.facade.setMode('foo');
    expect(rt.facade.mode.get()).toBe('foo');
    const result = await rt.facade.execute('<p>');
    expect(foo.execute).toHaveBeenCalledWith('<p>');
    expect(result.output[0].content).toBe('fake ran');
    rt.dispose();
  });

  it('an extra runner may start as the initial mode', () => {
    const foo = fakeRunner();
    const rt = create({ jsWorkerFactory, runners: { foo }, initialMode: 'foo' });
    expect(rt.facade.mode.get()).toBe('foo');
  });

  it('an extra runner cannot replace the built-in js runner', () => {
    expect(() => create({ jsWorkerFactory, runners: { js: fakeRunner() } })).toThrow(
      /"js"/,
    );
  });

  it('passes the jsConcurrency option to the JS runner', async () => {
    const rt = create({ jsWorkerFactory, jsConcurrency: 'queue' });
    const booted = rt.js.initialize();
    jsWorker.simulate({ type: 'ready' });
    await booted;
    void rt.js.execute('one');
    void rt.js.execute('two');
    await flush();
    expect(jsWorker.posted.filter((m) => m.type === 'run')).toHaveLength(1);
    expect(rt.js.queued.get()).toBe(1);
    rt.dispose();
  });

  it('passes the jsBootTimeoutMs option to the JS runner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const rt = create({ jsWorkerFactory, jsBootTimeoutMs: 50 });
      const booted = rt.js.initialize();
      vi.advanceTimersByTime(50);
      await expect(booted).rejects.toThrow('JS worker did not become ready within 50 ms.');
      expect(rt.facade.initError.get()).toBe('JS worker did not become ready within 50 ms.');
      rt.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('facade shows only the newest result when a JS run is superseded', async () => {
    // A supersede replaces the worker, so each new worker gets its own fake.
    const spawned = spawnEach();
    const rt = create({ jsWorkerFactory });
    const booted = rt.js.initialize();
    spawned[0].simulate({ type: 'ready' });
    await booted;
    const p1 = rt.facade.execute('old');
    await flush();
    const p2 = rt.facade.execute('new');
    expect((await p1).error).toBe('Execution superseded by a newer run.');
    spawned[1].simulate({ type: 'ready' });
    await flush();
    const [oldRun] = spawned[0].posted.filter((m) => m.type === 'run');
    const [newRun] = spawned[1].posted.filter((m) => m.type === 'run');
    expect(spawned[0].terminate).toHaveBeenCalled();
    spawned[0].simulate({ type: 'done', runId: oldRun.runId, success: true, timedOut: false });
    spawned[1].simulate({
      type: 'output',
      runId: newRun.runId,
      entry: { type: 'log', content: 'newest', timestamp: 1 },
    });
    spawned[1].simulate({ type: 'done', runId: newRun.runId, success: true, timedOut: false });
    await p2;
    expect(rt.facade.output.get().map((e) => e.content)).toEqual([
      '[no capabilities enabled]',
      'newest',
    ]);
    rt.dispose();
  });

  it('construction has no side effects: no worker is spawned', () => {
    build();
    expect(jsWorkerFactory).not.toHaveBeenCalled();
  });

  it.each([Infinity, NaN, 0, -5, 2 ** 31])(
    'throws a RangeError for a timeoutMs or jsBootTimeoutMs that is not a usable time limit: %d',
    (bad) => {
      expect(() => create({ jsWorkerFactory, timeoutMs: bad })).toThrow(RangeError);
      expect(() => create({ jsWorkerFactory, jsBootTimeoutMs: bad })).toThrow(RangeError);
      expect(jsWorkerFactory).not.toHaveBeenCalled();
    },
  );

  it('passes the jsRecycleAfterRuns option to the JS runner', async () => {
    const spawned = spawnEach();
    const rt = create({ jsWorkerFactory, jsRecycleAfterRuns: 1 });
    const onRecycle = vi.fn();
    rt.js.onRecycle(onRecycle);
    const booted = rt.js.initialize();
    spawned[0].simulate({ type: 'ready' });
    await booted;
    const p1 = rt.js.execute('one');
    await flush();
    const [run1] = spawned[0].posted.filter((m) => m.type === 'run');
    spawned[0].simulate({ type: 'done', runId: run1.runId, success: true, timedOut: false });
    await p1;
    expect(onRecycle).not.toHaveBeenCalled();

    void rt.js.execute('two');
    await flush();
    expect(onRecycle).toHaveBeenCalledExactlyOnceWith('periodic');
    expect(spawned).toHaveLength(2);
    expect(spawned[0].terminate).toHaveBeenCalled();
  });

  it('passes the jsRecoverExhaustion option to the JS runner', async () => {
    const spawned = spawnEach();
    const rt = create({ jsWorkerFactory, jsRecoverExhaustion: false });
    const booted = rt.js.initialize();
    spawned[0].simulate({ type: 'ready' });
    await booted;
    const p = rt.js.execute('x');
    await flush();
    const [run] = spawned[0].posted.filter((m) => m.type === 'run');
    spawned[0].simulate({
      type: 'done',
      runId: run.runId,
      success: false,
      error: 'out of memory',
      timedOut: false,
      exhausted: true,
    });
    await flush();
    // With recovery on (the default), the runner starts a second worker here.
    expect(spawned).toHaveLength(1);
    expect((await p).error).toBe('out of memory');
  });

  it('passes the jsMaxOutputChars option to the JS runner', async () => {
    const spawned = spawnEach();
    expect(() => create({ jsWorkerFactory, jsMaxOutputChars: 0 })).toThrow(RangeError);
    const rt = create({ jsWorkerFactory, jsMaxOutputChars: 4 });
    const booted = rt.js.initialize();
    spawned[0].simulate({ type: 'ready' });
    await booted;
    const p = rt.js.execute('x');
    await flush();
    const [run] = spawned[0].posted.filter((m) => m.type === 'run');
    expect(run.maxOutputChars).toBe(4);
    spawned[0].simulate({
      type: 'output',
      runId: run.runId,
      entry: { type: 'log', content: 'hello', timestamp: 1 },
    });
    spawned[0].simulate({ type: 'done', runId: run.runId, success: true, timedOut: false });
    expect((await p).output.map((e) => e.content)).toEqual([
      '[no capabilities enabled]',
      'Output limit reached (4 characters). The runner dropped the remaining output.',
    ]);
  });

  it('timeouts are plain options/properties', () => {
    const rt = build();
    expect(rt.js.timeoutMs).toBe(1234);
    rt.js.timeoutMs = 50;
    expect(rt.js.timeoutMs).toBe(50);
  });

  it('defaults: proxy disabled, js mode, 5 s budget', () => {
    const rt = create({ jsWorkerFactory });
    expect(rt.auth.proxyBase()).toBeNull();
    expect(rt.facade.mode.get()).toBe('js');
    expect(rt.js.timeoutMs).toBe(5000);
  });

  it('initialize() spawns through the supplied factory', async () => {
    const rt = build();
    void rt.js.initialize();
    expect(jsWorkerFactory).toHaveBeenCalledOnce();
    jsWorker.simulate({ type: 'ready' });
    await flush();
    expect(rt.js.ready.get()).toBe(true);
    expect(rt.facade.ready.get()).toBe(true);
  });

  describe('dispose()', () => {
    it('terminates the JS worker', async () => {
      const rt = build();
      void rt.js.initialize();
      await flush();
      rt.dispose();
      expect(jsWorker.terminate).toHaveBeenCalled();
    });

    it('drops every subscriber', async () => {
      const rt = build();
      const onJsReady = vi.fn();
      const onFacadeReady = vi.fn();
      const onCaps = vi.fn();
      const onToken = vi.fn();
      rt.js.ready.subscribe(onJsReady);
      rt.facade.ready.subscribe(onFacadeReady);
      rt.registry.capabilities.subscribe(onCaps);
      rt.auth.tokenInvalid.subscribe(onToken);
      void rt.js.initialize();
      rt.dispose();

      jsWorker.simulate({ type: 'ready' });
      await flush();
      rt.registry.register({
        name: 'x',
        description: 'x',
        stubInfo: { name: 'x', type: 'function' },
      });
      rt.auth.invalidate();
      sessionStorage.clear();

      expect(onJsReady).not.toHaveBeenCalled();
      expect(onFacadeReady).not.toHaveBeenCalled();
      expect(onCaps).not.toHaveBeenCalled();
      expect(onToken).not.toHaveBeenCalled();
    });

    it('settles an in-flight JS run as aborted without respawning', async () => {
      const rt = build();
      void rt.js.initialize();
      jsWorker.simulate({ type: 'ready' });
      await flush();
      const p = rt.js.execute('while (true) {}');
      await flush();
      rt.dispose();
      const result = await p;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution aborted.');
      expect(jsWorkerFactory).toHaveBeenCalledOnce();
    });

    it('initialize() after dispose is a no-op', async () => {
      const rt = build();
      rt.dispose();
      await rt.js.initialize();
      expect(jsWorkerFactory).not.toHaveBeenCalled();
    });
  });
});
