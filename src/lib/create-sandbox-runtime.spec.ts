import { vi } from 'vitest';
import { createSandboxRuntime } from './create-sandbox-runtime.js';
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

  beforeEach(() => {
    jsWorker = new FakeJsWorker();
    jsWorkerFactory = vi.fn(() => jsWorker as unknown as Worker);
  });

  function build() {
    return createSandboxRuntime({
      corsProxyUrl: '',
      jsWorkerFactory,
      timeoutMs: 1234,
    });
  }

  it('passes corsProxyUrl to the shared auth and starts the facade in js mode', () => {
    const rt = build();
    expect(rt.auth.proxyBase()).toBe('');
    expect(rt.facade.mode.get()).toBe('js');
    const remote = createSandboxRuntime({ jsWorkerFactory, corsProxyUrl: 'https://proxy.example' });
    expect(remote.auth.proxyBase()).toBe('https://proxy.example');
    expect(remote.auth).not.toBe(rt.auth);
  });

  it('A15: registers only a js runner by default', () => {
    const rt = build();
    expect(rt.facade.modes).toEqual(['js']);
    expect(rt.facade.runner('js')).toBe(rt.js);
    expect(() => rt.facade.setMode('text')).toThrow(/Unknown mode "text"/);
    expect(rt.facade.mode.get()).toBe('js');
  });

  it('A15: extra runners are registered under their keys and reachable via setMode', async () => {
    const foo = fakeRunner();
    const rt = createSandboxRuntime({ jsWorkerFactory, runners: { foo } });
    expect(rt.facade.modes).toEqual(['js', 'foo']);
    expect(rt.facade.runner('foo')).toBe(foo);
    rt.facade.setMode('foo');
    expect(rt.facade.mode.get()).toBe('foo');
    const result = await rt.facade.execute('<p>');
    expect(foo.execute).toHaveBeenCalledWith('<p>');
    expect(result.output[0].content).toBe('fake ran');
    rt.dispose();
  });

  it('A15: an extra runner may start as the initial mode', () => {
    const foo = fakeRunner();
    const rt = createSandboxRuntime({ jsWorkerFactory, runners: { foo }, initialMode: 'foo' });
    expect(rt.facade.mode.get()).toBe('foo');
  });

  it('A15: an extra runner cannot replace the built-in js runner', () => {
    expect(() => createSandboxRuntime({ jsWorkerFactory, runners: { js: fakeRunner() } })).toThrow(
      /"js"/,
    );
  });

  it('passes the jsConcurrency option to the JS runner', async () => {
    const rt = createSandboxRuntime({ jsWorkerFactory, jsConcurrency: 'queue' });
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
      const rt = createSandboxRuntime({ jsWorkerFactory, jsBootTimeoutMs: 50 });
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
    const spawned: FakeJsWorker[] = [];
    jsWorkerFactory.mockImplementation(() => {
      const w = new FakeJsWorker();
      spawned.push(w);
      return w as unknown as Worker;
    });
    const rt = createSandboxRuntime({ jsWorkerFactory });
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

  it('throws a RangeError for a timeoutMs or jsBootTimeoutMs that is not a usable time limit', () => {
    for (const bad of [Infinity, NaN, 0, -5, 2 ** 31]) {
      expect(() => createSandboxRuntime({ jsWorkerFactory, timeoutMs: bad })).toThrow(RangeError);
      expect(() => createSandboxRuntime({ jsWorkerFactory, jsBootTimeoutMs: bad })).toThrow(
        RangeError,
      );
    }
    expect(jsWorkerFactory).not.toHaveBeenCalled();
  });

  it('timeouts are plain options/properties', () => {
    const rt = build();
    expect(rt.js.timeoutMs).toBe(1234);
    rt.js.timeoutMs = 50;
    expect(rt.js.timeoutMs).toBe(50);
  });

  it('defaults: proxy disabled, js mode, 5 s budget', () => {
    const rt = createSandboxRuntime({ jsWorkerFactory });
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
