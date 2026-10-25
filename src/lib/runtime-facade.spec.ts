import { vi } from 'vitest';
import { RuntimeFacade } from './runtime-facade.js';
import { createValue } from './shared/readable-value.js';
import type { ExecutionResult } from './shared/sandbox-types.js';

function makeResult(extra: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    output: [],
    timedOut: false,
    durationMs: 0,
    ...extra,
  };
}

function makeMockRunner(initialReady = true, label?: string) {
  const ready = createValue(initialReady);
  const isRunning = createValue(false);
  const initError = createValue<string | null>(null);
  return {
    label,
    ready: ready.asReadonly(),
    isRunning: isRunning.asReadonly(),
    initError: initError.asReadonly(),
    activeTag: createValue<string | null>(null).asReadonly(),
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(makeResult()),
    abort: vi.fn().mockResolvedValue(undefined),
    onOutput: vi.fn(() => () => undefined),
    _ready: ready,
    _isRunning: isRunning,
    _initError: initError,
  };
}

describe('RuntimeFacade', () => {
  let facade: RuntimeFacade;
  let jsRunner: ReturnType<typeof makeMockRunner>;
  let textRunner: ReturnType<typeof makeMockRunner>;

  function build(initialMode?: string): RuntimeFacade {
    return new RuntimeFacade({ js: jsRunner, text: textRunner }, initialMode);
  }

  beforeEach(() => {
    jsRunner = makeMockRunner(true, 'JavaScript');
    textRunner = makeMockRunner(true, 'Text');
    facade = build();
  });

  afterEach(() => {
    facade.dispose();
  });

  it('construction has no side effects (no runner is initialised)', () => {
    expect(jsRunner.initialize).not.toHaveBeenCalled();
    expect(textRunner.initialize).not.toHaveBeenCalled();
  });

  it('starts in js mode with empty output by default', () => {
    expect(facade.mode.get()).toBe('js');
    expect(facade.output.get()).toEqual([]);
  });

  it('honours the initial mode without emitting a "switched" entry', () => {
    const f = build('text');
    expect(f.mode.get()).toBe('text');
    expect(f.output.get()).toEqual([]);
    f.dispose();
  });

  it('ready/isRunning/initError re-expose the active runner', () => {
    expect(facade.ready.get()).toBe(true);
    jsRunner._ready.set(false);
    expect(facade.ready.get()).toBe(false);
    expect(facade.isRunning.get()).toBe(false);
    jsRunner._isRunning.set(true);
    expect(facade.isRunning.get()).toBe(true);
    expect(facade.initError.get()).toBeNull();
    jsRunner._initError.set('js broke');
    expect(facade.initError.get()).toBe('js broke');
  });

  it('ready/isRunning/initError re-expose the text runner in text mode', () => {
    jsRunner._ready.set(false);
    jsRunner._isRunning.set(true);
    jsRunner._initError.set('js broke');
    facade.setMode('text');
    expect(facade.ready.get()).toBe(true);
    expect(facade.isRunning.get()).toBe(false);
    expect(facade.initError.get()).toBeNull();
    textRunner._isRunning.set(true);
    textRunner._initError.set('text broke');
    expect(facade.isRunning.get()).toBe(true);
    expect(facade.initError.get()).toBe('text broke');
  });

  it('ready follows the mode, notifying subscribers synchronously', () => {
    const seen: boolean[] = [];
    facade.ready.subscribe((v) => seen.push(v));
    textRunner._ready.set(false); // inactive: silent
    expect(seen).toEqual([]);
    facade.setMode('text'); // text not ready
    expect(seen).toEqual([false]);
    textRunner._ready.set(true);
    expect(seen).toEqual([false, true]);
    // A change on an inactive runner that leaves the result unchanged is silent.
    jsRunner._ready.set(false);
    expect(seen).toEqual([false, true]);
  });

  it.each([
    ['JS', 'js', '1 + 1'],
    ['text', 'text', 'plain'],
  ] as const)('run() dispatches to the %s runner while mode is %s', async (_label, mode, code) => {
    const runners = { js: jsRunner, text: textRunner };
    const other = mode === 'js' ? textRunner : jsRunner;
    facade.setMode(mode);
    await facade.run(code);
    expect(runners[mode].execute).toHaveBeenCalledExactlyOnceWith(code);
    expect(other.execute).not.toHaveBeenCalled();
  });

  it('execute()/run() forward per-run options to the active runner', async () => {
    await facade.execute('a', { tag: 'claude', timeoutMs: 10 });
    expect(jsRunner.execute).toHaveBeenLastCalledWith('a', { tag: 'claude', timeoutMs: 10 });
    await facade.run('b', { tag: 'event' });
    expect(jsRunner.execute).toHaveBeenLastCalledWith('b', { tag: 'event' });
  });

  it('run() while the active runner is not ready passes the call to the runner', async () => {
    jsRunner._ready.set(false);
    jsRunner.execute.mockResolvedValueOnce(makeResult({ success: false, error: 'not ready' }));
    const result = await facade.run('1');
    expect(jsRunner.execute).toHaveBeenCalledWith('1');
    expect(result.error).toBe('not ready');
  });

  it('result output replaces the facade output', async () => {
    const out = [{ type: 'log' as const, content: 'hi', timestamp: 0 }];
    jsRunner.execute.mockResolvedValueOnce(makeResult({ output: out }));
    await facade.run('console.log("hi")');
    expect(facade.output.get()).toBe(out);
  });

  describe('setMode()', () => {
    it('setting the current mode is a no-op', () => {
      const onMode = vi.fn();
      const onOutput = vi.fn();
      facade.mode.subscribe(onMode);
      facade.output.subscribe(onOutput);
      facade.setMode('js');
      expect(onMode).not.toHaveBeenCalled();
      expect(onOutput).not.toHaveBeenCalled();
      expect(jsRunner.abort).not.toHaveBeenCalled();
      expect(facade.output.get()).toEqual([]);
    });

    it('updates mode and calls abort() on the previously active runner', () => {
      facade.setMode('text');
      expect(facade.mode.get()).toBe('text');
      expect(jsRunner.abort).toHaveBeenCalledOnce();
      expect(textRunner.abort).not.toHaveBeenCalled();
    });

    it('emits the exact AC #5 system entry replacing prior output', async () => {
      jsRunner.execute.mockResolvedValueOnce(
        makeResult({ output: [{ type: 'log', content: 'prior', timestamp: 0 }] }),
      );
      await facade.run('prior');
      facade.setMode('text');
      expect(facade.output.get()).toEqual([
        expect.objectContaining({ type: 'system', content: 'Switched to Text mode' }),
      ]);
      facade.setMode('js');
      expect(facade.output.get()).toEqual([
        expect.objectContaining({ type: 'system', content: 'Switched to JavaScript mode' }),
      ]);
    });

    it('switching to a ready runner never initializes it', () => {
      facade.setMode('text');
      facade.setMode('js');
      expect(jsRunner.initialize).not.toHaveBeenCalled();
      expect(textRunner.initialize).not.toHaveBeenCalled();
    });

    it('notifies mode subscribers synchronously, once per change', () => {
      const seen: string[] = [];
      facade.mode.subscribe((m) => seen.push(m));
      facade.setMode('text');
      facade.setMode('text');
      facade.setMode('js');
      expect(seen).toEqual(['text', 'js']);
    });
  });

  it('stale result from superseded runner is discarded', async () => {
    let resolveFirst: (r: ExecutionResult) => void = () => {};
    const firstPromise = new Promise<ExecutionResult>((r) => (resolveFirst = r));
    jsRunner.execute.mockReturnValueOnce(firstPromise);

    const firstExecute = facade.run('slow');
    // Start a second execute that completes before the first resolves.
    facade.setMode('text');
    await facade.run('fast');

    resolveFirst(makeResult({ output: [{ type: 'log', content: 'stale', timestamp: 0 }] }));
    await firstExecute;

    expect(facade.output.get().some((e) => e.content === 'stale')).toBe(false);
  });

  it('stale result from an older run in the same mode is discarded', async () => {
    let resolveFirst: (r: ExecutionResult) => void = () => {};
    jsRunner.execute.mockReturnValueOnce(new Promise<ExecutionResult>((r) => (resolveFirst = r)));
    const fresh = [{ type: 'log' as const, content: 'fresh', timestamp: 0 }];
    jsRunner.execute.mockResolvedValueOnce(makeResult({ output: fresh }));

    const firstExecute = facade.run('slow');
    await facade.run('fast');
    expect(facade.output.get()).toBe(fresh);

    const staleResult = makeResult({ output: [{ type: 'log', content: 'stale', timestamp: 0 }] });
    resolveFirst(staleResult);
    // The caller still gets its own result. Only the facade output ignores it.
    expect(await firstExecute).toBe(staleResult);
    expect(facade.output.get()).toBe(fresh);
  });

  it('mode switch during an in-flight run does not throw', async () => {
    let resolve: (r: ExecutionResult) => void = () => {};
    jsRunner.execute.mockReturnValueOnce(new Promise<ExecutionResult>((r) => (resolve = r)));
    const p = facade.run('long');
    expect(() => facade.setMode('text')).not.toThrow();
    resolve(makeResult({ output: [{ type: 'log', content: 'late', timestamp: 0 }] }));
    await p;
    // The result of the old mode does not replace the "switched" entry.
    expect(facade.output.get()).toEqual([
      expect.objectContaining({ type: 'system', content: 'Switched to Text mode' }),
    ]);
  });

  it('abort() delegates to the active runner', async () => {
    facade.setMode('text');
    await facade.abort();
    expect(textRunner.abort).toHaveBeenCalledOnce();
  });

  it('dispose() drops subscribers and detaches from the runners', () => {
    const onReady = vi.fn();
    const onOutput = vi.fn();
    facade.ready.subscribe(onReady);
    facade.output.subscribe(onOutput);
    facade.dispose();
    jsRunner._ready.set(false);
    // A detached derived value does not compute again.
    expect(facade.ready.get()).toBe(true);
    facade.setMode('text');
    expect(onReady).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
  });
});

// ---------- Pluggable runner map ----------
describe('RuntimeFacade — runner map', () => {
  let js: ReturnType<typeof makeMockRunner>;
  let foo: ReturnType<typeof makeMockRunner>;
  let facade: RuntimeFacade;

  beforeEach(() => {
    js = makeMockRunner(true, 'JavaScript');
    foo = makeMockRunner(true);
    facade = new RuntimeFacade({ js, foo });
  });

  afterEach(() => {
    facade.dispose();
  });

  it('setMode() accepts any registered key and execute() dispatches to that runner', async () => {
    facade.setMode('foo');
    expect(facade.mode.get()).toBe('foo');
    await facade.execute('bar()', { tag: 't' });
    expect(foo.execute).toHaveBeenCalledWith('bar()', { tag: 't' });
    expect(js.execute).not.toHaveBeenCalled();
    await facade.abort();
    expect(foo.abort).toHaveBeenCalledOnce();
  });

  it('ready / isRunning / initError track the active runner', () => {
    foo._ready.set(false);
    foo._isRunning.set(true);
    foo._initError.set('foo broke');
    expect(facade.ready.get()).toBe(true);
    expect(facade.isRunning.get()).toBe(false);
    expect(facade.initError.get()).toBeNull();

    facade.setMode('foo');
    expect(facade.ready.get()).toBe(false);
    expect(facade.isRunning.get()).toBe(true);
    expect(facade.initError.get()).toBe('foo broke');

    foo._ready.set(true);
    foo._isRunning.set(false);
    foo._initError.set(null);
    expect(facade.ready.get()).toBe(true);
    expect(facade.isRunning.get()).toBe(false);
    expect(facade.initError.get()).toBeNull();
  });

  it('system entries use the runner label, falling back to the key', async () => {
    facade.setMode('foo');
    expect(facade.output.get()).toEqual([
      expect.objectContaining({ type: 'system', content: 'Switched to foo mode' }),
    ]);
    facade.setMode('js');
    expect(facade.output.get()).toEqual([
      expect.objectContaining({ type: 'system', content: 'Switched to JavaScript mode' }),
    ]);
  });

  it('modes lists the keys and runner() returns the registered runner', () => {
    expect(facade.modes).toEqual(['js', 'foo']);
    expect(facade.runner('foo')).toBe(foo);
    expect(() => facade.runner('nope')).toThrow(/nope/);
  });

  it('setMode() with an unknown key throws naming it and changes nothing', async () => {
    const out = [{ type: 'log' as const, content: 'kept', timestamp: 0 }];
    js.execute.mockResolvedValueOnce(makeResult({ output: out }));
    await facade.execute('x');
    const onMode = vi.fn();
    const onOutput = vi.fn();
    facade.mode.subscribe(onMode);
    facade.output.subscribe(onOutput);

    expect(() => facade.setMode('ruby')).toThrow(/Unknown mode "ruby"/);

    expect(facade.mode.get()).toBe('js');
    expect(facade.output.get()).toBe(out);
    expect(onMode).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
    expect(js.abort).not.toHaveBeenCalled();
  });

  it('an unknown initial mode throws at construction', () => {
    expect(() => new RuntimeFacade({ js }, 'nope')).toThrow(/Unknown mode "nope"/);
  });

  it('switching to a runner that is not ready initializes it exactly once', () => {
    foo._ready.set(false);
    facade.setMode('foo');
    facade.setMode('js');
    facade.setMode('foo');
    expect(foo.initialize).toHaveBeenCalledOnce();
    expect(js.initialize).not.toHaveBeenCalled();
  });

  it('a rejected initialize() surfaces through initError without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    const proc = (
      globalThis as {
        process?: { on(e: string, fn: () => void): void; off(e: string, fn: () => void): void };
      }
    ).process;
    proc?.on('unhandledRejection', unhandled);
    try {
      foo._ready.set(false);
      foo.initialize.mockRejectedValueOnce(new Error('foo failed to load'));
      facade.setMode('foo');
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(foo.initialize).toHaveBeenCalledOnce();
      expect(facade.initError.get()).toBe('foo failed to load');
      facade.setMode('js');
      expect(facade.initError.get()).toBeNull();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      proc?.off('unhandledRejection', unhandled);
    }
  });

  it("the runner's own initError wins over the facade's record", async () => {
    foo._ready.set(false);
    foo.initialize.mockImplementationOnce(async () => {
      foo._initError.set('runner says why');
      throw new Error('generic');
    });
    facade.setMode('foo');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(facade.initError.get()).toBe('runner says why');
  });

  // Lazy-init failure handling.
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("clears the facade's init failure once the runner becomes ready", async () => {
    foo._ready.set(false);
    foo.initialize.mockRejectedValueOnce(new Error('foo failed to load'));
    facade.setMode('foo');
    await flush();
    expect(facade.initError.get()).toBe('foo failed to load');

    // Recovered outside the facade (a manual retry or a respawn).
    foo._ready.set(true);
    expect(facade.initError.get()).toBeNull();
    foo._ready.set(false);
    expect(facade.initError.get()).toBeNull();
  });

  it('switching back to a mode whose lazy init failed retries it', async () => {
    foo._ready.set(false);
    foo.initialize.mockRejectedValueOnce(new Error('foo failed to load'));
    facade.setMode('foo');
    await flush();
    facade.setMode('js');
    facade.setMode('foo');
    expect(foo.initialize).toHaveBeenCalledTimes(2);
    // The stale failure is dropped while the retry is in flight.
    expect(facade.initError.get()).toBeNull();
    await flush();
    expect(facade.initError.get()).toBeNull();
  });

  it('a failed retry reports the new failure', async () => {
    foo._ready.set(false);
    foo.initialize
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));
    facade.setMode('foo');
    await flush();
    facade.setMode('js');
    facade.setMode('foo');
    await flush();
    expect(facade.initError.get()).toBe('second');
  });

  it('a synchronous initialize() throw surfaces through initError and setMode does not throw', () => {
    foo._ready.set(false);
    foo.initialize.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    expect(() => facade.setMode('foo')).not.toThrow();
    expect(facade.mode.get()).toBe('foo');
    expect(facade.initError.get()).toBe('sync boom');
  });

  it('never initializes a not-ready initial-mode runner (the caller boots it)', () => {
    foo._ready.set(false);
    const f = new RuntimeFacade({ js, foo }, 'foo');
    expect(foo.initialize).not.toHaveBeenCalled();
    f.dispose();
  });
});
