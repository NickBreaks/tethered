import { vi } from 'vitest';
import {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSAsyncWASMModule,
} from 'quickjs-emscripten-core';
import { JsWorkerHost } from './worker-host.js';
import { fixRuntimeFreeOrder } from './runtime-free-order.js';
import { MAX_HOST_CALL_ARG_CHARS } from './capability-bridge.js';
import {
  MAX_ERROR_CHARS,
  OUTPUT_ENTRY_COST,
  TIMEOUT_MSG,
  type JsCapabilitySnapshot,
  type JsWorkerToMainMsg,
} from '../lib/js/worker-protocol.js';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';

// The engine host, driven directly: no runner, no worker. These specs
// examine the `done` message that the host posts. That message is the
// only place where the host can tell the runner about a timeout or a
// spent heap. The guest must not be able to forge either one.

// Keep each WASM module that the host loads, so that a spec can read the
// size of its heap. The module itself does not change.
const loaded = vi.hoisted(() => ({ modules: [] as QuickJSAsyncWASMModule[] }));
vi.mock('quickjs-emscripten-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('quickjs-emscripten-core')>();
  return {
    ...real,
    newQuickJSAsyncWASMModuleFromVariant: async (
      ...args: Parameters<typeof real.newQuickJSAsyncWASMModuleFromVariant>
    ) => {
      const module = await real.newQuickJSAsyncWASMModuleFromVariant(...args);
      loaded.modules.push(module);
      return module;
    },
  };
});

/** The byte length of the WASM memory of a module. WASM memory only grows. */
function heapBytes(module: QuickJSAsyncWASMModule): number {
  // `module` is protected in the `.d.ts` of the library.
  return (module as unknown as { module: { HEAPU8: Uint8Array } }).module.HEAPU8.buffer.byteLength;
}

type DoneMsg = Extract<JsWorkerToMainMsg, { type: 'done' }>;

interface RunReport {
  done: DoneMsg;
  output: OutputEntry[];
}

describe('JsWorkerHost', () => {
  let host: JsWorkerHost;
  let runSeq = 0;
  const outputs = new Map<number, OutputEntry[]>();
  const waiting = new Map<number, (done: DoneMsg) => void>();

  beforeAll(async () => {
    host = new JsWorkerHost((msg) => {
      if (msg.type === 'output') {
        outputs.get(msg.runId)?.push(msg.entry);
      } else if (msg.type === 'done') {
        waiting.get(msg.runId)?.(msg);
      }
    });
    await host.init();
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(
    code: string,
    options: {
      timeoutMs?: number;
      maxOutputChars?: number;
      capabilities?: JsCapabilitySnapshot[];
    } = {},
  ): Promise<RunReport> {
    const runId = ++runSeq;
    const output: OutputEntry[] = [];
    outputs.set(runId, output);
    const done = new Promise<DoneMsg>((resolve) => waiting.set(runId, resolve));
    host.handleMessage({
      type: 'run',
      runId,
      code,
      timeoutMs: options.timeoutMs ?? 2000,
      maxOutputChars: options.maxOutputChars ?? 1_048_576,
      capabilities: options.capabilities ?? [],
    });
    return { done: await done, output };
  }

  describe('exhausted flag', () => {
    it.each([
      ["throw new Error('out of memory')"],
      ["throw new InternalError('out of memory')"],
      ["throw { name: 'InternalError', message: 'out of memory' }"],
      ["throw new InternalError('stack overflow')"],
      ['throw "capability \'x\' setup failed: {}"'],
      ["Promise.reject(new InternalError('out of memory'))"],
    ])(
      'a guest that runs %s does not set exhausted',
      async (code) => {
        const { done } = await run(code);
        expect(done.success).toBe(false);
        expect(done.timedOut).toBe(false);
        expect(done.exhausted).toBeUndefined();
      },
      10_000,
    );

    const brokenCap: JsCapabilitySnapshot = {
      name: 'broken',
      enabled: true,
      hostBacked: true,
      stub: { type: 'object', name: 'broken', methods: ['go'] },
      setupScript: 'throw 1',
    };

    it('is not set when a capability setup fails and a fresh engine can start', async () => {
      const { done } = await run('1', { capabilities: [brokenCap] });
      expect(done.success).toBe(false);
      expect(done.error).toContain("capability 'broken' setup failed");
      expect(done.exhausted).toBeUndefined();
    }, 10_000);

    it('is set when a capability setup fails and a fresh engine cannot start', async () => {
      const real = QuickJSAsyncWASMModule.prototype.newRuntime;
      let calls = 0;
      vi.spyOn(QuickJSAsyncWASMModule.prototype, 'newRuntime').mockImplementation(function (
        this: QuickJSAsyncWASMModule,
        ...args: Parameters<typeof real>
      ) {
        calls++;
        if (calls === 2) throw new Error('engine failed');
        return real.apply(this, args);
      });
      const { done } = await run('1', { capabilities: [brokenCap] });
      expect(calls).toBe(2);
      expect(done.success).toBe(false);
      expect(done.exhausted).toBe(true);
    }, 10_000);

    // A failure before the guest code starts sets the flag, also when its
    // text does not tell of a spent heap.
    it.each([['out of memory'], ['engine failed']])(
      'is set when the engine runtime of the run cannot start (%s)',
      async (message) => {
        vi.spyOn(QuickJSAsyncWASMModule.prototype, 'newRuntime').mockImplementation(() => {
          throw new Error(message);
        });
        const { done } = await run('1');
        expect(done.success).toBe(false);
        expect(done.error).toBe(message);
        expect(done.exhausted).toBe(true);
      },
      10_000,
    );

    it('is set after an out-of-memory error only when a fresh engine cannot start', async () => {
      const real = QuickJSAsyncWASMModule.prototype.newRuntime;
      let calls = 0;
      vi.spyOn(QuickJSAsyncWASMModule.prototype, 'newRuntime').mockImplementation(function (
        this: QuickJSAsyncWASMModule,
        ...args: Parameters<typeof real>
      ) {
        // The first call makes the runtime of the run. The second call is
        // the check for a spent heap.
        calls++;
        if (calls === 2) throw new Error('out of memory');
        return real.apply(this, args);
      });
      const { done } = await run("throw new InternalError('out of memory')");
      expect(calls).toBe(2);
      expect(done.success).toBe(false);
      expect(done.exhausted).toBe(true);
    }, 10_000);

    it('a host error after the guest code starts does not set it', async () => {
      vi.spyOn(QuickJSAsyncContext.prototype, 'getPromiseState').mockImplementation(() => {
        throw new Error('out of memory');
      });
      const { done } = await run('1');
      expect(done.success).toBe(false);
      expect(done.error).toBe('out of memory');
      expect(done.exhausted).toBeUndefined();
    }, 10_000);
  });

  describe('timedOut flag', () => {
    it.each([
      ["throw { name: 'InternalError', message: 'interrupted' }"],
      ["throw new InternalError('interrupted')"],
      ["Promise.reject({ name: 'InternalError', message: 'interrupted' })"],
    ])(
      'a guest that runs %s does not time out',
      async (code) => {
        const { done, output } = await run(code);
        expect(done.success).toBe(false);
        expect(done.timedOut).toBe(false);
        expect(done.error).toMatch(/^InternalError: interrupted/);
        expect(output).not.toContainEqual(expect.objectContaining({ type: 'system' }));
      },
      10_000,
    );

    it('is set when the interrupt handler stops a hot loop', async () => {
      const { done } = await run('while (true) {}', { timeoutMs: 100 });
      expect(done.timedOut).toBe(true);
      expect(done.error).toBe('Execution timed out: script exceeded the time limit.');
    }, 10_000);

    it('is set when the interrupt handler stops a promise job, with no guest error entry', async () => {
      const { done, output } = await run('Promise.resolve().then(() => { while (true) {} })', {
        timeoutMs: 100,
      });
      expect(done.timedOut).toBe(true);
      expect(output.filter((e) => e.type === 'error')).toEqual([]);
    }, 10_000);

    it('is set for a promise chain that never ends', async () => {
      const t0 = Date.now();
      const { done } = await run('function f() { Promise.resolve().then(f) } f()', {
        timeoutMs: 200,
      });
      expect(done.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3000);
    }, 10_000);
  });

  describe('output limit', () => {
    // Each entry costs its characters plus OUTPUT_ENTRY_COST.
    const C = OUTPUT_ENTRY_COST;

    it('posts the entries in the limit, then the next entry cut to one character over it', async () => {
      const { done, output } = await run(
        "console.log('12345'); console.warn('abcdefghij'); console.log('more'); 'result'",
        { maxOutputChars: 10 + 2 * C },
      );
      expect(done).toEqual({
        type: 'done',
        runId: expect.any(Number),
        success: true,
        timedOut: false,
      });
      expect(output.map((e) => [e.type, e.content])).toEqual([
        ['log', '12345'],
        ['warn', 'abcdef'],
      ]);
    }, 10_000);

    it('posts an entry that fills the limit exactly', async () => {
      const { output } = await run("console.log('12345'); '12345'", {
        maxOutputChars: 10 + 2 * C,
      });
      expect(output.map((e) => [e.type, e.content])).toEqual([
        ['log', '12345'],
        ['result', '12345'],
      ]);
    }, 10_000);

    it('stops the posts of a loop that logs large strings, and still posts done', async () => {
      const { done, output } = await run(
        "for (let i = 0; i < 1000; i++) console.log('x'.repeat(10000))",
        { maxOutputChars: 50_000 + 6 * C },
      );
      expect(done.success).toBe(true);
      expect(output).toHaveLength(6);
      expect(output.reduce((n, e) => n + e.content.length, 0)).toBe(50_001);
    }, 10_000);

    it('counts system and error entries of the worker', async () => {
      const { done, output } = await run("console.log('123456789'); throw new Error('boom')", {
        maxOutputChars: 10 + 2 * C,
      });
      expect(done.success).toBe(false);
      expect(done.error).toMatch(/^Error: boom/);
      expect(output.map((e) => [e.type, e.content])).toEqual([
        ['log', '123456789'],
        ['error', 'Er'],
      ]);
      const timedOut = await run("console.log('123456789'); while (true) {}", {
        maxOutputChars: 10 + 2 * C,
        timeoutMs: 100,
      });
      expect(timedOut.done.timedOut).toBe(true);
      expect(timedOut.output.map((e) => [e.type, e.content])).toEqual([
        ['log', '123456789'],
        ['system', 'Ex'],
      ]);
    }, 10_000);

    it('charges the fixed cost for empty entries, and posts the entry over the limit empty', async () => {
      const { done, output } = await run('for (let i = 0; i < 1000; i++) console.log()', {
        maxOutputChars: 10 * C,
      });
      expect(done.success).toBe(true);
      expect(output).toHaveLength(11);
      expect(output.every((e) => e.type === 'log' && e.content === '')).toBe(true);
    }, 10_000);
  });

  describe('timeout while the result is read', () => {
    it.each([
      ['({ toJSON() { for (;;) {} } })'],
      ['Promise.reject({ toJSON() { for (;;) {} } })'],
      ['Promise.resolve({ toJSON() { for (;;) {} } })'],
      ['throw { toJSON() { for (;;) {} } }'],
    ])(
      '%s times out',
      async (code) => {
        const { done, output } = await run(code, { timeoutMs: 300 });
        expect(done.success).toBe(false);
        expect(done.timedOut).toBe(true);
        expect(done.error).toBe(TIMEOUT_MSG);
        expect(output.filter((e) => e.type === 'result' || e.type === 'error')).toEqual([]);
      },
      10_000,
    );
  });

  describe('error limit', () => {
    it('posts an error of at most MAX_ERROR_CHARS characters', async () => {
      const { done } = await run("throw new Error('x'.repeat(1e7))", { timeoutMs: 10_000 });
      expect(done.success).toBe(false);
      expect(done.error).toMatch(/^Error: x/);
      expect(done.error!.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
    }, 30_000);
  });
});

// The capabilities and the host of the specs below. A broken module cannot
// be used again. Thus each spec starts a new host.
const off: JsCapabilitySnapshot = {
  name: 'off',
  enabled: false,
  hostBacked: true,
  stub: { type: 'function', name: 'off' },
};
const timer: JsCapabilitySnapshot = {
  name: 'timer',
  enabled: true,
  hostBacked: false,
  stub: { type: 'function', name: 'timer', globals: ['setTimeout'] },
};
const echo: JsCapabilitySnapshot = {
  name: 'echo',
  enabled: true,
  hostBacked: true,
  stub: { type: 'object', name: 'echo', methods: ['say'] },
};

interface Host {
  run: (code: string, capabilities?: JsCapabilitySnapshot[]) => Promise<RunReport>;
  module: QuickJSAsyncWASMModule;
  /** The arguments of each `cap-call` message that the host posted. */
  capCalls: unknown[][];
}

async function newHost(): Promise<Host> {
  let runSeq = 0;
  const outputs = new Map<number, OutputEntry[]>();
  const waiting = new Map<number, (done: DoneMsg) => void>();
  const capCalls: unknown[][] = [];
  // The main thread of the spec answers each host call with its first argument.
  const host: JsWorkerHost = new JsWorkerHost((msg) => {
    if (msg.type === 'output') outputs.get(msg.runId)?.push(msg.entry);
    else if (msg.type === 'done') waiting.get(msg.runId)?.(msg);
    else if (msg.type === 'cap-call') {
      capCalls.push(msg.args);
      queueMicrotask(() =>
        host.handleMessage({
          type: 'cap-result',
          callId: msg.callId,
          ok: true,
          value: msg.args[0],
        }),
      );
    }
  });
  await host.init();
  const module = loaded.modules.at(-1)!;
  const run = async (code: string, capabilities = [off]): Promise<RunReport> => {
    const runId = ++runSeq;
    const output: OutputEntry[] = [];
    outputs.set(runId, output);
    const done = new Promise<DoneMsg>((resolve) => waiting.set(runId, resolve));
    host.handleMessage({
      type: 'run',
      runId,
      code,
      timeoutMs: 5000,
      maxOutputChars: 1_048_576,
      capabilities,
    });
    return { done: await done, output };
  };
  return { run, module, capCalls };
}

describe('JsWorkerHost host call arguments', () => {
  it('refuses a call whose arguments expand over the limit, with a guest error and no post', async () => {
    const { run, capCalls } = await newHost();
    // About 20 million characters of JSON from one shared object of 1 KB.
    const { done, output } = await run(
      "const a = new Array(2e4).fill({ s: 'y'.repeat(1000) }); try { echo.say(a) } catch (e) { console.log(e.name + ': ' + e.message) } 'after'",
      [echo],
    );
    expect(done).toEqual(expect.objectContaining({ success: true }));
    expect(output.map((e) => e.content)).toEqual([
      `RangeError: say(): the host call arguments exceed ${MAX_HOST_CALL_ARG_CHARS} characters`,
      'after',
    ]);
    expect(capCalls).toEqual([]);
  }, 60_000);

  it('counts all the arguments of one call together', async () => {
    const { run, capCalls } = await newHost();
    const half = MAX_HOST_CALL_ARG_CHARS / 2;
    const { done, output } = await run(
      `const s = 'x'.repeat(${half}); echo.say(s, s + 'x').length`,
      [echo],
    );
    expect(done.success).toBe(false);
    expect(done.error).toMatch(/^RangeError: say\(\): the host call arguments exceed/);
    expect(capCalls).toEqual([]);
    expect(output.filter((e) => e.type === 'result')).toEqual([]);
    const ok = await run(`echo.say('x'.repeat(${half}), 'y'.repeat(${half})).length`, [echo]);
    expect(ok.done.success).toBe(true);
    expect(ok.output.map((e) => e.content)).toEqual([String(half)]);
    expect(capCalls).toHaveLength(1);
  }, 60_000);
});

describe('JsWorkerHost broken flag', () => {
  const DEEP_LOG = 'let a = []; for (let i = 0; i < 10000; i++) a = [a]; console.log(a)';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is not set for a normal run, a guest error or a disabled stub', async () => {
    const { run } = await newHost();
    for (const code of ['1', 'console.log(1)', 'throw 1', 'off()', '1']) {
      const { done } = await run(code);
      expect(done.broken).toBeUndefined();
    }
    expect((await run('40 + 2')).done.success).toBe(true);
  }, 30_000);

  it('is set when the engine fails to free the runtime after a deep array dump', async () => {
    const { run } = await newHost();
    const { done, output } = await run(DEEP_LOG);
    expect(done.success).toBe(false);
    expect(done.broken).toBe(true);
    expect(done.exhausted).toBeUndefined();
    expect(output.at(-1)).toEqual(
      expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('failed to free'),
      }),
    );
  }, 30_000);

  it('refuses all later runs, with no output', async () => {
    const { run } = await newHost();
    await run(DEEP_LOG);
    for (const code of ['console.log(1); 1', 'off()']) {
      const { done, output } = await run(code);
      expect(done).toEqual(
        expect.objectContaining({ success: false, timedOut: false, broken: true }),
      );
      expect(done.error).toContain('failed to free');
      expect(output).toEqual([]);
    }
  }, 30_000);

  it('is set when a free of the runtime throws, also when the guest code did not fail', async () => {
    const { run } = await newHost();
    const real = QuickJSAsyncRuntime.prototype.dispose;
    vi.spyOn(QuickJSAsyncRuntime.prototype, 'dispose').mockImplementationOnce(function (
      this: QuickJSAsyncRuntime,
    ) {
      real.call(this);
      throw new Error('free failed');
    });
    const { done } = await run('40 + 2');
    expect(done.success).toBe(false);
    expect(done.broken).toBe(true);
  }, 30_000);

  it('is set when a free of the runtime throws the error of a missing runtime', async () => {
    const { run } = await newHost();
    vi.spyOn(QuickJSAsyncRuntime.prototype, 'dispose').mockImplementationOnce(() => {
      throw new Error(
        'QuickJSRuntime(rt = 1) not found when trying to free HostRef(id = -2147483648)',
      );
    });
    const { done } = await run('40 + 2');
    expect(done.success).toBe(false);
    expect(done.broken).toBe(true);
  }, 30_000);
});

// quickjs-emscripten-core 0.32.0 deletes the callbacks of an async runtime
// before it frees the runtime. Without the fix in runtime-free-order.ts,
// the free throws, and each run leaks its runtime in the WASM heap.
describe('JsWorkerHost runtime free', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('frees a run with host functions, stubs and timers with no error', async () => {
    const { run } = await newHost();
    const disposeContext = vi.spyOn(QuickJSAsyncContext.prototype, 'dispose');
    const disposeRuntime = vi.spyOn(QuickJSAsyncRuntime.prototype, 'dispose');
    const code =
      "console.log(echo.say('a')); setTimeout(() => console.log('t'), 1); try { off() } catch {} 1";
    for (let i = 0; i < 3; i++) {
      const { done, output } = await run(code, [off, timer, echo]);
      expect(done).toEqual(expect.objectContaining({ success: true }));
      expect(done.broken).toBeUndefined();
      expect(output.map((e) => e.content)).toEqual(['a', 't', '1']);
    }
    for (const spy of [disposeContext, disposeRuntime]) {
      expect(spy).toHaveBeenCalled();
      for (const result of spy.mock.results) expect(result.type).toBe('return');
    }
  }, 30_000);

  it('keeps the WASM heap flat over 200 runs that allocate about 2 MB each', async () => {
    const { run, module } = await newHost();
    const code =
      "let a = []; for (let i = 0; i < 10000; i++) a.push({ i, s: 'x'.repeat(100) + i }); console.log(a.length); off.length";
    // The first run grows the heap to its working size.
    expect((await run(code, [off, echo])).done.success).toBe(true);
    const start = heapBytes(module);
    for (let i = 0; i < 200; i++) {
      const { done } = await run(code, [off, echo]);
      expect(done.success).toBe(true);
      expect(done.broken).toBeUndefined();
    }
    expect(heapBytes(module) - start).toBeLessThanOrEqual(32 * 1024 * 1024);
  }, 120_000);

  it('applies the fix once for each module, and fails for a module of an unknown shape', () => {
    expect(() => fixRuntimeFreeOrder(loaded.modules.at(-1)!)).not.toThrow();
    expect(() => fixRuntimeFreeOrder({} as QuickJSAsyncWASMModule)).toThrow(/cannot be applied/);
  });
});
