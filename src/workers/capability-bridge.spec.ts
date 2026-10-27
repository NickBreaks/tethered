import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncWASMModule,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { TIMEOUT_MSG } from '../lib/js/worker-protocol.js';
import { injectCapabilityBridge, MAX_HOST_CALL_ARG_CHARS } from './capability-bridge.js';
import { SuspendGate } from './engine-async.js';
import { fixRuntimeFreeOrder } from './runtime-free-order.js';

// The bridge reads the arguments of a host call in the worker. It refuses
// a call after the deadline and a call with arguments over the limit,
// before the call goes to the main thread.
describe('injectCapabilityBridge', () => {
  let module: QuickJSAsyncWASMModule;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;
  let gate: SuspendGate;
  let calls: unknown[][];
  let inTime: boolean;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
    fixRuntimeFreeOrder(module);
  }, 30_000);

  beforeEach(() => {
    runtime = module.newRuntime();
    vm = runtime.newContext();
    gate = new SuspendGate();
    calls = [];
    inTime = true;
    injectCapabilityBridge(
      vm,
      { name: 'echo', stub: { type: 'object', name: 'echo', methods: ['say'] } },
      (_method, args) => {
        calls.push(args);
        return Promise.resolve(args.length);
      },
      gate,
      () => inTime,
    );
  });

  afterEach(() => {
    vm.dispose();
    runtime.dispose();
  });

  async function evalAndDump(code: string): Promise<unknown> {
    const result = await gate.suspendable(() => vm.evalCodeAsync(code));
    const handle = result.error ?? result.value;
    try {
      return vm.dump(handle);
    } finally {
      if (handle.alive) handle.dispose();
    }
  }

  const catchCall = (args: string): string =>
    `(() => { try { echo.say(${args}); return 'no error' } catch (e) { return [e.name, e.message] } })()`;

  it('relays the arguments of a call in the limit', async () => {
    const result = await evalAndDump(
      "echo.say('a', 1, { b: [true, null] }, Promise.resolve(2), undefined)",
    );
    expect(result).toBe(5);
    expect(calls).toEqual([
      ['a', 1, { b: [true, null] }, { type: 'fulfilled', value: 2 }, undefined],
    ]);
  });

  it('refuses a call after the deadline before it reads the arguments', async () => {
    inTime = false;
    const result = await evalAndDump(
      `let read = false; ${catchCall('{ toJSON() { read = true; return 1 } }')}.concat(read)`,
    );
    expect(result).toEqual(['Error', TIMEOUT_MSG, false]);
    expect(calls).toEqual([]);
  });

  it('refuses a string over the limit with a RangeError', async () => {
    const result = await evalAndDump(catchCall(`'x'.repeat(${MAX_HOST_CALL_ARG_CHARS + 1})`));
    expect(result).toEqual([
      'RangeError',
      `say(): the host call arguments exceed ${MAX_HOST_CALL_ARG_CHARS} characters`,
    ]);
    expect(calls).toEqual([]);
  }, 30_000);

  it('refuses an object whose JSON is over the limit, also when it is in a promise', async () => {
    const big = "new Array(2e4).fill({ s: 'y'.repeat(1000) })";
    for (const arg of [big, `Promise.resolve(${big})`]) {
      const result = await evalAndDump(catchCall(arg));
      expect(result).toEqual([
        'RangeError',
        `say(): the host call arguments exceed ${MAX_HOST_CALL_ARG_CHARS} characters`,
      ]);
    }
    expect(calls).toEqual([]);
  }, 30_000);

  it('counts a symbol by its description and a bigint by its digits', async () => {
    const tooLarge = [
      'RangeError',
      `say(): the host call arguments exceed ${MAX_HOST_CALL_ARG_CHARS} characters`,
    ];
    const longSymbol = `Symbol('x'.repeat(${MAX_HOST_CALL_ARG_CHARS + 1}))`;
    expect(await evalAndDump(catchCall(longSymbol))).toEqual(tooLarge);
    const nearLimit = `'x'.repeat(${MAX_HOST_CALL_ARG_CHARS - 2}), 123n`;
    expect(await evalAndDump(catchCall(nearLimit))).toEqual(tooLarge);
    expect(calls).toEqual([]);
    expect(await evalAndDump(catchCall("Symbol('s'), 12n"))).toBe('no error');
    expect(calls).toEqual([[expect.any(Symbol), 12n]]);
  }, 30_000);

  it('relays a pending promise and a rejected promise as their states', async () => {
    const result = await evalAndDump(
      "const p = Promise.reject(new TypeError('r')); p.catch(() => {}); echo.say(new Promise(() => {}), p)",
    );
    expect(result).toBe(2);
    expect(calls).toEqual([
      [
        { type: 'pending' },
        { type: 'rejected', error: expect.objectContaining({ name: 'TypeError', message: 'r' }) },
      ],
    ]);
  });

  it('relays a value without JSON as text, also when its toJSON() throws', async () => {
    const result = await evalAndDump(
      "echo.say(function f() {}, { toJSON() { throw new Error('no') } })",
    );
    expect(result).toBe(2);
    expect(calls).toEqual([['function f() {}', '[object Object]']]);
  });

  describe('host results and host errors', () => {
    let reply: () => Promise<unknown>;

    beforeEach(() => {
      injectCapabilityBridge(
        vm,
        { name: 'host', stub: { type: 'object', name: 'host', methods: ['get'] } },
        () => reply(),
        gate,
      );
    });

    it('builds guest values from a nested host result', async () => {
      reply = () =>
        Promise.resolve({ list: [1, 'two', true, false, null, undefined], inner: { ok: true } });
      const result = await evalAndDump(`
        const r = host.get();
        [Array.isArray(r.list), r.list.length, r.list[5] === undefined, r.inner.ok, Object.keys(r)]
      `);
      expect(result).toEqual([true, 6, true, true, ['list', 'inner']]);
    });

    it('gives the guest an Error with the message of a host Error', async () => {
      reply = () => Promise.reject(new Error('host said no'));
      const result = await evalAndDump(
        '(() => { try { host.get(); return "no error" } catch (e) { return [e instanceof Error, e.message] } })()',
      );
      expect(result).toEqual([true, 'host said no']);
    });

    it('gives the guest an Error with the text of a host rejection that is not an Error', async () => {
      reply = () => Promise.reject('plain text');
      const result = await evalAndDump(
        '(() => { try { host.get(); return "no error" } catch (e) { return [e instanceof Error, e.message] } })()',
      );
      expect(result).toEqual([true, 'plain text']);
    });
  });

  describe('stub shapes and setup scripts', () => {
    it('injects one global function for each name of a function stub', async () => {
      const methods: string[] = [];
      injectCapabilityBridge(
        vm,
        { name: 'pair', stub: { type: 'function', name: 'pair', globals: ['first', 'second'] } },
        (method) => {
          methods.push(method);
          return Promise.resolve(method.length);
        },
        gate,
      );
      expect(await evalAndDump('[typeof pair, first(), second()]')).toEqual(['undefined', 5, 6]);
      expect(methods).toEqual(['first', 'second']);
    });

    it('injects a global function with the stub name when a function stub has no globals', async () => {
      injectCapabilityBridge(
        vm,
        { name: 'solo', stub: { type: 'function', name: 'solo' } },
        () => Promise.resolve('hi'),
        gate,
      );
      expect(await evalAndDump('solo()')).toBe('hi');
    });

    it('injects an empty object for an object stub without methods', async () => {
      injectCapabilityBridge(
        vm,
        { name: 'bare', stub: { type: 'object', name: 'bare' } },
        () => Promise.resolve(),
        gate,
      );
      expect(await evalAndDump('[typeof bare, Object.keys(bare)]')).toEqual(['object', []]);
    });

    it('runs the setup script after it injects the stub', async () => {
      injectCapabilityBridge(
        vm,
        {
          name: 'wrapped',
          stub: { type: 'object', name: 'wrapped', methods: ['raw'] },
          setupScript: 'wrapped.twice = (x) => wrapped.raw(x) * 2; 1',
        },
        (_method, args) => Promise.resolve(args[0]),
        gate,
      );
      expect(await evalAndDump('wrapped.twice(21)')).toBe(42);
    });

    it('throws with the capability name when the setup script fails', () => {
      expect(() =>
        injectCapabilityBridge(
          vm,
          {
            name: 'broken',
            stub: { type: 'object', name: 'broken', methods: [] },
            setupScript: "throw new Error('bad setup')",
          },
          () => Promise.resolve(),
          gate,
        ),
      ).toThrow(/^capability 'broken' setup failed: .*bad setup/);
    });
  });
});
