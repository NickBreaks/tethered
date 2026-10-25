import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import type { OutputEntry } from '../lib/shared/sandbox-types.js';
import { GuestTimers } from './guest-timers.js';
import { SuspendGate } from './engine-async.js';

// Engine-side timer globals, moved from the core TimerCapability:
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

  it('drainEventLoop runs the promise jobs and fires the timers in due-time order', async () => {
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
    const drained = await timers.drainEventLoop(
      runtime,
      vm,
      (e) => emitted.push(e),
      Date.now() + 5000,
      () => false,
      new SuspendGate(),
    );
    expect(drained).toEqual({ timedOut: false, hadError: false });
    expect(emitted).toEqual([]);
    // Virtual time: the interval fires at 8, 16 and 24.
    expect(await evalAndDump('order')).toEqual(['job', 'i1', 't10', 'i2', 'i3', 't30']);
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
    });
  });

  it.each([
    [
      'pending timers',
      `setTimeout(() => {}, 100);
       setTimeout(() => {}, 200);
       setInterval(() => {}, 50);`,
      3,
    ],
    [
      'mixed pending and cleared timers',
      `const a = setTimeout(() => {}, 100);
       const b = setTimeout(() => {}, 200);
       const c = setInterval(() => {}, 50);
       clearTimeout(b);`,
      2,
    ],
  ])('should dispose all callback handles when cleanup runs with %s', async (_, code, alive) => {
    const before = liveObjects();
    await evalAndDump(code);
    // Each pending callback stays alive. The clear disposed the cleared one.
    expect(liveObjects()).toBe(before + alive);
    timers.cleanup();
    expect(liveObjects()).toBe(before);
  });

  /** Runs the event loop until no timers remain. */
  async function drain(): Promise<OutputEntry[]> {
    const emitted: OutputEntry[] = [];
    const drained = await timers.drainEventLoop(
      runtime,
      vm,
      (e) => emitted.push(e),
      Date.now() + 5000,
      () => false,
      new SuspendGate(),
    );
    expect(drained).toEqual({ timedOut: false, hadError: false });
    return emitted;
  }

  describe('pending timer limit', () => {
    it('a clear removes the timer and disposes its callback at once', async () => {
      const before = liveObjects();
      // Without the removal, the 10001st pair hits the limit.
      const count = await evalAndDump(`
        (() => {
          let n = 0;
          for (let i = 0; i < 100000; i++) {
            clearTimeout(setTimeout(() => {}, 10));
            clearInterval(setInterval(() => {}, 10));
            n++;
          }
          return n;
        })()
      `);
      expect(count).toBe(100000);
      expect(liveObjects()).toBe(before);
      expect(await drain()).toEqual([]);
    }, 30_000);

    it.each(['setTimeout', 'setInterval'])(
      '%s throws a RangeError when 10000 timers are pending',
      async (fnName) => {
        const result = await evalAndDump(`
          (() => {
            for (let i = 0; i < 10000; i++) ${fnName}(() => {}, 10);
            try {
              ${fnName}(() => {}, 10);
              return { thrown: false };
            } catch (e) {
              return { thrown: true, isRangeError: e instanceof RangeError, message: e.message };
            }
          })()
        `);
        expect(result).toEqual({
          thrown: true,
          isRangeError: true,
          message: `${fnName}: too many pending timers (the limit is 10000)`,
        });
      },
    );

    it('a timer that fired is not pending', async () => {
      await evalAndDump(`
        globalThis.fired = 0;
        for (let i = 0; i < 9999; i++) setTimeout(() => fired++, 1);
        // When this callback runs, no timer is pending. It is itself a fired
        // one-shot timer.
        setTimeout(() => {
          for (let i = 0; i < 10000; i++) setTimeout(() => fired++, 1);
        }, 2);
        0;
      `);
      expect(await drain()).toEqual([]);
      expect(await evalAndDump('fired')).toBe(19999);
    });
  });

  describe('clear from a timer callback', () => {
    it('a timeout that clears itself runs once, and its callback is disposed', async () => {
      const before = liveObjects();
      await evalAndDump(`
        (() => {
          globalThis.calls = 0;
          const id = setTimeout(() => { calls++; clearTimeout(id); }, 5);
        })()
      `);
      expect(await drain()).toEqual([]);
      expect(await evalAndDump('calls')).toBe(1);
      await evalAndDump('delete globalThis.calls');
      expect(liveObjects()).toBe(before);
    });

    it('an interval that clears itself is not rescheduled, and its callback is disposed', async () => {
      const before = liveObjects();
      await evalAndDump(`
        (() => {
          globalThis.ticks = 0;
          const id = setInterval(() => { ticks++; if (ticks === 2) clearInterval(id); }, 5);
        })()
      `);
      expect(await drain()).toEqual([]);
      expect(await evalAndDump('ticks')).toBe(2);
      await evalAndDump('delete globalThis.ticks');
      expect(liveObjects()).toBe(before);
    });

    it('a callback that clears a later timer with the same due time stops it', async () => {
      await evalAndDump(`
        globalThis.order = [];
        let later;
        setTimeout(() => { order.push('first'); clearTimeout(later); clearInterval(other); }, 5);
        later = setTimeout(() => order.push('later'), 5);
        const other = setInterval(() => order.push('other'), 5);
        setTimeout(() => order.push('last'), 5);
        0;
      `);
      expect(await drain()).toEqual([]);
      expect(await evalAndDump('order')).toEqual(['first', 'last']);
    });
  });
}, 30_000);
