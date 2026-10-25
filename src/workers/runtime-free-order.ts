import type { JSRuntimePointer, QuickJSAsyncWASMModule } from 'quickjs-emscripten-core';

/**
 * The two protected fields of the module that the fix changes. The
 * `.d.ts` of the library marks them `protected`. Thus this file reads
 * them through this type.
 */
interface FreeOrderFields {
  callbacks?: { deleteRuntime?: unknown };
  ffi?: { QTS_FreeRuntime?: unknown };
}

type RuntimeFn = (rt: JSRuntimePointer) => void;

/** The modules that have the fix. A second call on one module does nothing. */
const fixed = new WeakSet<QuickJSAsyncWASMModule>();

/**
 * Makes the async module free a runtime before it deletes the callbacks
 * of that runtime.
 *
 * This is a workaround for quickjs-emscripten-core 0.32.0. Remove it when
 * the engine is replaced or the library is fixed. In that version, the
 * async module deletes the callbacks first and then frees the runtime.
 * The sync module uses the correct order. During the free, the engine
 * calls the host to free each host reference. The host cannot find the
 * runtime and throws. The throw stops `JS_FreeRuntime`, and almost all of
 * the runtime stays in the WASM heap. Thus each run leaks its heap.
 *
 * With this fix, `deleteRuntime` only records the runtime. The free of
 * that runtime then deletes the callbacks after `QTS_FreeRuntime`, also
 * when the free throws.
 *
 * @throws Error when the module does not have the expected fields. Then
 *   the library changed, and this fix must be examined again.
 */
export function fixRuntimeFreeOrder(module: QuickJSAsyncWASMModule): void {
  if (fixed.has(module)) return;
  const fields = module as unknown as FreeOrderFields;
  const callbacks = fields.callbacks;
  const ffi = fields.ffi;
  if (
    typeof callbacks?.deleteRuntime !== 'function' ||
    typeof ffi?.QTS_FreeRuntime !== 'function'
  ) {
    throw new Error(
      'The engine module does not have callbacks.deleteRuntime or ffi.QTS_FreeRuntime. ' +
        'The workaround for the free order of quickjs-emscripten-core 0.32.0 cannot be applied.',
    );
  }
  const deleteRuntime = (callbacks.deleteRuntime as RuntimeFn).bind(callbacks);
  const freeRuntime = ffi.QTS_FreeRuntime as RuntimeFn;
  // The runtime whose callbacks the module tried to delete before the free.
  let pending: JSRuntimePointer | null = null;
  callbacks.deleteRuntime = (rt: JSRuntimePointer): void => {
    pending = rt;
  };
  ffi.QTS_FreeRuntime = (rt: JSRuntimePointer): void => {
    try {
      freeRuntime(rt);
    } finally {
      if (pending === rt) {
        pending = null;
        deleteRuntime(rt);
      }
    }
  };
  fixed.add(module);
}
