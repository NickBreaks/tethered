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
});
