import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { GuestTimers } from './guest-timers.js';

// Engine-side timer globals, relocated from the core TimerCapability (A23):
// the capability is now a descriptor and the worker owns this implementation.
describe('GuestTimers', () => {
  let module: QuickJSAsyncWASMModule;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  }, 30_000);

  beforeEach(() => {
    runtime = module.newRuntime();
    vm = runtime.newContext();
  });

  afterEach(() => {
    try { vm.dispose(); } catch { /* may already be disposed */ }
    try { runtime.dispose(); } catch { /* may already be disposed */ }
  });

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

  it('A23: exposes install, drainEventLoop and cleanup', () => {
    const timers = new GuestTimers();
    expect(typeof timers.install).toBe('function');
    expect(typeof timers.drainEventLoop).toBe('function');
    expect(typeof timers.cleanup).toBe('function');
  });

  it('should register all four timer globals as functions in the VM', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    const types = await evalAndDump(`
      [typeof setTimeout, typeof setInterval, typeof clearTimeout, typeof clearInterval]
    `);
    expect(types).toEqual(['function', 'function', 'function', 'function']);
    cap.cleanup();
  });

  it('should return a positive integer from setTimeout', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    const id = await evalAndDump(`setTimeout(() => {}, 0)`);
    expect(typeof id).toBe('number');
    expect(id as number).toBeGreaterThan(0);
    expect(Number.isInteger(id as number)).toBe(true);
    cap.cleanup();
  });

  it('should return distinct integer IDs from successive setTimeout calls', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    const ids = await evalAndDump(`[setTimeout(() => {}, 0), setTimeout(() => {}, 0)]`);
    const arr = ids as number[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).not.toBe(arr[1]);
    cap.cleanup();
  });

  it('should throw TypeError when setTimeout callback is a string', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    const result = await evalAndDump(`
      try {
        setTimeout("alert('oops')", 0);
        ({ thrown: false });
      } catch (e) {
        ({ thrown: true, isTypeError: e instanceof TypeError, message: e.message });
      }
    `);
    expect(result).toEqual({
      thrown: true,
      isTypeError: true,
      message: 'setTimeout: callback must be a function',
    });
    cap.cleanup();
  });

  it('should throw TypeError when setInterval callback is a string', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    const result = await evalAndDump(`
      try {
        setInterval("alert('oops')", 0);
        ({ thrown: false });
      } catch (e) {
        ({ thrown: true, isTypeError: e instanceof TypeError, message: e.message });
      }
    `);
    expect(result).toEqual({
      thrown: true,
      isTypeError: true,
      message: 'setInterval: callback must be a function',
    });
    cap.cleanup();
  });

  it('should clean up pending timers without leaking handles', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    await evalAndDump(`
      setTimeout(() => {}, 100);
      setTimeout(() => {}, 200);
      setInterval(() => {}, 50);
    `);
    expect(cap.hasPendingTimers()).toBe(true);
    cap.cleanup();
    expect(cap.hasPendingTimers()).toBe(false);
    // vm + runtime disposed by afterEach without throwing
  });

  it('should dispose all callback handles when cleanup runs with mixed pending and cleared timers', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    await evalAndDump(`
      const a = setTimeout(() => {}, 100);
      const b = setTimeout(() => {}, 200);
      const c = setInterval(() => {}, 50);
      clearTimeout(b);
      a + c; // just produce a value
    `);
    // a and c are still pending
    expect(cap.hasPendingTimers()).toBe(true);
    cap.cleanup();
    expect(cap.hasPendingTimers()).toBe(false);
    // vm + runtime disposed cleanly by afterEach
  });

  it('hasPendingTimers should reflect registry state across operations', async () => {
    const cap = new GuestTimers();
    cap.install(vm);
    expect(cap.hasPendingTimers()).toBe(false);

    await evalAndDump(`globalThis.__id = setTimeout(() => {}, 100)`);
    expect(cap.hasPendingTimers()).toBe(true);

    await evalAndDump(`clearTimeout(globalThis.__id)`);
    expect(cap.hasPendingTimers()).toBe(false);

    await evalAndDump(`setTimeout(() => {}, 100)`);
    expect(cap.hasPendingTimers()).toBe(true);

    cap.cleanup();
    expect(cap.hasPendingTimers()).toBe(false);
  });
}, 30_000);
