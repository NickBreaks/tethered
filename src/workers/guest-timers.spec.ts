import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';
import { GuestTimers } from './guest-timers.js';

// Engine-side timer globals, moved from the core TimerCapability (A23):
// the capability is now a descriptor and the worker owns this implementation.
describe('GuestTimers', () => {
  let module: QuickJSAsyncWASMModule;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;
  let timers: GuestTimers;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  }, 30_000);

  beforeEach(() => {
    runtime = module.newRuntime();
    vm = runtime.newContext();
    timers = new GuestTimers();
    timers.install(vm);
  });

  afterEach(() => {
    timers.cleanup();
    // The engine can throw during dispose, also when no handle leaks.
    try { vm.dispose(); } catch { /* may already be disposed */ }
    try { runtime.dispose(); } catch { /* may already be disposed */ }
  });

  /** The number of live objects in the runtime. A leaked handle keeps its object alive. */
  function liveObjects(): number {
    const usage = runtime.computeMemoryUsage();
    try {
      return (vm.dump(usage) as { obj_count: number }).obj_count;
    } finally {
      usage.dispose();
    }
  }

  async function evalAndDump(code: string): Promise<unknown> {
    const result = await vm.evalCodeAsync(code);
    if ('value' in result) {
      const val = vm.dump(result.value);
      result.value.dispose();
      return val;
    } else {
      const err = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`Eval failed: ${JSON.stringify(err)}`);
    }
  }

  it('A23: drainEventLoop runs the promise jobs and fires the timers in due-time order', async () => {
    await evalAndDump(`
      globalThis.order = [];
      setTimeout(() => order.push('t30'), 30);
      setTimeout(() => order.push('t10'), 10);
      let ticks = 0;
      const id = setInterval(() => {
        ticks++;
        order.push('i' + ticks);
        if (ticks === 3) clearInterval(id);
      }, 8);
      Promise.resolve().then(() => order.push('job'));
      0;
    `);
    const emitted: OutputEntry[] = [];
    const drained = await timers.drainEventLoop(runtime, vm, (e) => emitted.push(e), Date.now() + 5000);
    expect(drained).toEqual({ timedOut: false, hadError: false });
    expect(emitted).toEqual([]);
    // Virtual time: the interval fires at 8, 16 and 24.
    expect(await evalAndDump('order')).toEqual(['job', 'i1', 't10', 'i2', 'i3', 't30']);
    expect(timers.hasPendingTimers()).toBe(false);
  });

  it('should register all four timer globals as functions in the VM', async () => {
    const types = await evalAndDump(`
      [typeof setTimeout, typeof setInterval, typeof clearTimeout, typeof clearInterval]
    `);
    expect(types).toEqual(['function', 'function', 'function', 'function']);
  });

  describe.each(['setTimeout', 'setInterval'])('%s', (fnName) => {
    it('should return distinct positive integer IDs from successive calls', async () => {
      const ids = (await evalAndDump(`[${fnName}(() => {}, 0), ${fnName}(() => {}, 0)]`)) as number[];
      expect(ids).toHaveLength(2);
      for (const id of ids) {
        expect(Number.isInteger(id)).toBe(true);
        expect(id).toBeGreaterThan(0);
      }
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('should throw TypeError when the callback is a string', async () => {
      const result = await evalAndDump(`
        try {
          ${fnName}("alert('oops')", 0);
          ({ thrown: false });
        } catch (e) {
          ({ thrown: true, isTypeError: e instanceof TypeError, message: e.message });
        }
      `);
      expect(result).toEqual({
        thrown: true,
        isTypeError: true,
        message: `${fnName}: callback must be a function`,
      });
      expect(timers.hasPendingTimers()).toBe(false);
    });
  });

  it.each([
    [
      'pending timers',
      `setTimeout(() => {}, 100);
       setTimeout(() => {}, 200);
       setInterval(() => {}, 50);`,
    ],
    [
      'mixed pending and cleared timers',
      `const a = setTimeout(() => {}, 100);
       const b = setTimeout(() => {}, 200);
       const c = setInterval(() => {}, 50);
       clearTimeout(b);`,
    ],
  ])('should dispose all callback handles when cleanup runs with %s', async (_, code) => {
    const before = liveObjects();
    await evalAndDump(code);
    expect(timers.hasPendingTimers()).toBe(true);
    // Each of the three callbacks stays alive, also the cleared one.
    expect(liveObjects()).toBe(before + 3);
    timers.cleanup();
    expect(timers.hasPendingTimers()).toBe(false);
    expect(liveObjects()).toBe(before);
  });

  it('hasPendingTimers should reflect registry state across operations', async () => {
    expect(timers.hasPendingTimers()).toBe(false);

    await evalAndDump(`globalThis.__id = setTimeout(() => {}, 100)`);
    expect(timers.hasPendingTimers()).toBe(true);

    await evalAndDump(`clearTimeout(globalThis.__id)`);
    expect(timers.hasPendingTimers()).toBe(false);

    await evalAndDump(`setTimeout(() => {}, 100)`);
    expect(timers.hasPendingTimers()).toBe(true);

    timers.cleanup();
    expect(timers.hasPendingTimers()).toBe(false);
  });
}, 30_000);
