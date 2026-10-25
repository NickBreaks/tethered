import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSHandle,
} from 'quickjs-emscripten-core';

/*
 * Async engine calls for promise jobs and guest functions.
 *
 * An asyncified host function (`vm.newAsyncifiedFunction`) can suspend
 * the engine only when the engine entered guest code through an async
 * export call. quickjs-emscripten-core 0.32 makes such a call only in
 * `evalCodeAsync`. `runtime.executePendingJobs` and `vm.callFunction` are
 * synchronous. A host call in a promise job or in a timer callback thus
 * cannot suspend there. The guest then stays pending, with no error.
 *
 * The FFI of the asyncify variant has `QTS_ExecutePendingJob_MaybeAsync`
 * and `QTS_Call_MaybeAsync`. In 0.32, these are the plain wasm exports,
 * because `cwrap` gives the plain export when all arguments are numbers
 * and no options are given. They never return a promise. Thus this module
 * wraps the two exports again with `cwrap(..., { async: true })`. That is
 * the Emscripten API for an export that can suspend.
 *
 * The two functions below mirror `QuickJSRuntime.executePendingJobs` and
 * `QuickJSContext.callFunction` of quickjs-emscripten-core 0.32. They use
 * protected members of the engine classes (`module`, `ffi`, `rt`, `ctx`,
 * `contextMap`, `memory`). Of the async engine calls, this module is the
 * only place that reads them. The package.json pins both quickjs packages
 * to the exact version for this reason. When you change the version,
 * compare these functions with the new engine source.
 */

/** The pointer types of the engine. In the wasm memory, they are numbers. */
type RuntimePointer = Parameters<QuickJSAsyncContext['getMemory']>[0];
type ValuePointer = Parameters<ReturnType<QuickJSAsyncContext['getMemory']>['heapValueHandle']>[0];
type CharPointer = Parameters<
  ReturnType<QuickJSAsyncContext['getMemory']>['consumeJSCharPointer']
>[0];

/** The part of the Emscripten module that this module uses. */
interface EngineModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  cwrap(
    ident: string,
    returnType: 'number',
    argTypes: 'number'[],
    opts: { async: true },
  ): (...args: unknown[]) => unknown;
}

/** Protected members of `QuickJSAsyncRuntime` (0.32). */
interface RuntimeInternals {
  module: EngineModule;
  rt: { value: RuntimePointer };
  ffi: { QTS_FreeValuePointerRuntime(rt: RuntimePointer, value: ValuePointer): void };
  contextMap: Map<number, QuickJSAsyncContext>;
}

/** Protected members of `QuickJSAsyncContext` (0.32). */
interface ContextInternals {
  module: EngineModule;
  rt: { value: RuntimePointer };
  ctx: { value: number };
  ffi: {
    QTS_ResolveException(ctx: number, value: ValuePointer): ValuePointer;
    QTS_FreeValuePointer(ctx: number, value: ValuePointer): void;
    QTS_Dump(ctx: number, value: QuickJSHandle['value']): CharPointer;
  };
  memory: { consumeJSCharPointer(ptr: CharPointer): string };
}

interface AsyncExports {
  executePendingJob(
    rt: RuntimePointer,
    maxJobs: number,
    lastJobContext: number,
  ): Promise<ValuePointer>;
  call(
    ctx: number,
    fn: QuickJSHandle['value'],
    thisVal: QuickJSHandle['value'],
    argc: number,
    argv: number,
  ): Promise<ValuePointer>;
}

const exportsByModule = new WeakMap<EngineModule, AsyncExports>();

function asyncExports(module: EngineModule): AsyncExports {
  let found = exportsByModule.get(module);
  if (!found) {
    if (typeof module.cwrap !== 'function' || !(module.HEAPU8 instanceof Uint8Array)) {
      throw new Error('engine-async: the engine module does not have the expected shape');
    }
    const num = 'number' as const;
    const opts = { async: true } as const;
    const executePendingJob = module.cwrap('QTS_ExecutePendingJob', num, [num, num, num], opts);
    const call = module.cwrap('QTS_Call', num, [num, num, num, num, num], opts);
    found = {
      executePendingJob: async (...args) => (await executePendingJob(...args)) as ValuePointer,
      call: async (...args) => (await call(...args)) as ValuePointer,
    };
    exportsByModule.set(module, found);
  }
  return found;
}

function runtimeInternals(runtime: QuickJSAsyncRuntime): RuntimeInternals {
  const r = runtime as unknown as RuntimeInternals;
  if (!r.module || !r.rt || !(r.contextMap instanceof Map) || !r.ffi) {
    throw new Error('engine-async: the engine runtime does not have the expected shape');
  }
  return r;
}

function contextInternals(vm: QuickJSAsyncContext): ContextInternals {
  const c = vm as unknown as ContextInternals;
  if (!c.module || typeof c.ctx?.value !== 'number' || !c.rt || !c.ffi || !c.memory) {
    throw new Error('engine-async: the engine context does not have the expected shape');
  }
  return c;
}

/** The result of one call of `executePendingJobsAsync()`. */
type AsyncJobsResult =
  { executed: number; error?: undefined } | { executed?: undefined; error: QuickJSHandle };

/**
 * Runs at most `maxJobs` promise jobs (-1 for all). A host call in a job
 * can suspend the engine. On a job error, it returns the error handle.
 * The caller must dispose that handle. Mirrors
 * `QuickJSRuntime.executePendingJobs` of quickjs-emscripten-core 0.32.
 */
export async function executePendingJobsAsync(
  runtime: QuickJSAsyncRuntime,
  maxJobs: number,
): Promise<AsyncJobsResult> {
  const r = runtimeInternals(runtime);
  const fns = asyncExports(r.module);
  // The engine writes the context of the last job into this cell.
  const ctxCell = r.module._malloc(4);
  try {
    new Int32Array(r.module.HEAPU8.buffer, ctxCell, 1)[0] = 0;
    const valuePtr = await fns.executePendingJob(r.rt.value, maxJobs, ctxCell);
    // Make a new view. The memory can grow while the engine is suspended,
    // and then an old view is detached.
    const ctxPtr = new Int32Array(r.module.HEAPU8.buffer, ctxCell, 1)[0];
    if (ctxPtr === 0) {
      r.ffi.QTS_FreeValuePointerRuntime(r.rt.value, valuePtr);
      return { executed: 0 };
    }
    const context = r.contextMap.get(ctxPtr);
    if (!context) {
      r.ffi.QTS_FreeValuePointerRuntime(r.rt.value, valuePtr);
      throw new Error('engine-async: a promise job ran in an unknown context');
    }
    const handle = context.getMemory(r.rt.value).heapValueHandle(valuePtr);
    if (context.typeof(handle) === 'number') {
      const executed = context.getNumber(handle);
      handle.dispose();
      return { executed };
    }
    return { error: handle };
  } finally {
    r.module._free(ctxCell);
  }
}

/** The result of one call of `callFunctionAsync()`. */
type AsyncCallResult =
  { value: QuickJSHandle; error?: undefined } | { value?: undefined; error: QuickJSHandle };

/**
 * Calls the guest function `fn`. A host call in `fn` can suspend the
 * engine. The caller must dispose the handle in the result. Mirrors
 * `QuickJSContext.callFunction` of quickjs-emscripten-core 0.32.
 */
export async function callFunctionAsync(
  vm: QuickJSAsyncContext,
  fn: QuickJSHandle,
  thisVal: QuickJSHandle,
  args: QuickJSHandle[] = [],
): Promise<AsyncCallResult> {
  vm.runtime.assertOwned(fn);
  const c = contextInternals(vm);
  const fns = asyncExports(c.module);
  const memory = vm.getMemory(c.rt.value);
  const argv = memory.toPointerArray(args);
  let resultPtr: ValuePointer;
  try {
    resultPtr = await fns.call(c.ctx.value, fn.value, thisVal.value, args.length, argv.value);
  } finally {
    argv.dispose();
  }
  const errorPtr = c.ffi.QTS_ResolveException(c.ctx.value, resultPtr);
  if (errorPtr) {
    c.ffi.QTS_FreeValuePointer(c.ctx.value, resultPtr);
    return { error: memory.heapValueHandle(errorPtr) };
  }
  return { value: memory.heapValueHandle(resultPtr) };
}

/**
 * Returns the text that `vm.dump()` parses for an object: JSON from the
 * engine, or a plain string when the engine cannot make JSON. The engine
 * makes this string in its own heap, thus the memory limit applies to it.
 * The caller can examine its length before `JSON.parse()` makes objects
 * in the worker. The engine can call guest code (`toJSON`). Mirrors the
 * object branch of `QuickJSContext.dump` of quickjs-emscripten-core 0.32.
 */
export function dumpJson(vm: QuickJSAsyncContext, handle: QuickJSHandle): string {
  vm.runtime.assertOwned(handle);
  const c = contextInternals(vm);
  return c.memory.consumeJSCharPointer(c.ffi.QTS_Dump(c.ctx.value, handle.value));
}

/**
 * Tells an asyncified host function if it can suspend the engine now.
 *
 * The engine can suspend only when the stack from the async export call
 * to the host function has no other host frame. A synchronous host
 * function (for example, `console.log`) can call guest code, for example
 * `toJSON()` when it reads an argument. A host call from there cannot
 * suspend. If it tries, the engine continues with a wrong value and the
 * guest can stay pending, with no error. Thus the host functions use this
 * gate. They make the call fail with a guest error when the gate is
 * closed.
 */
export class SuspendGate {
  #asyncDepth = 0;
  #syncDepth = 0;

  /** True when a host function can suspend the engine now. */
  get open(): boolean {
    return this.#asyncDepth > 0 && this.#syncDepth === 0;
  }

  /** Runs an async engine call. During the call, the gate is open. */
  async suspendable<T>(call: () => Promise<T>): Promise<T> {
    this.#asyncDepth++;
    try {
      return await call();
    } finally {
      this.#asyncDepth--;
    }
  }

  /** Runs a synchronous host function. During the function, the gate is closed. */
  hostOnly<T>(fn: () => T): T {
    this.#syncDepth++;
    try {
      return fn();
    } finally {
      this.#syncDepth--;
    }
  }
}
