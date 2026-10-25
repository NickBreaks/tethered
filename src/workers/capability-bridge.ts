import type {
  AsyncFunctionImplementation,
  QuickJSAsyncContext,
  QuickJSHandle,
} from 'quickjs-emscripten-core';
import type { CapabilityStubInfo } from '../lib/capabilities/capability.js';
import { TIMEOUT_MSG } from '../lib/js/worker-protocol.js';
import { dumpJson, type SuspendGate } from './engine-async.js';

/**
 * The maximum size of the arguments of one host call, in characters. Each
 * string argument counts with its length. Each other object counts with
 * the length of its JSON from the engine. The bridge examines the JSON
 * before it parses it. Thus a large object graph, for example an array
 * that holds one object many times, does not expand in the worker. A call
 * over this limit fails with a guest error and does not go to the main
 * thread.
 */
export const MAX_HOST_CALL_ARG_CHARS = 16 * 1024 * 1024;

/** The arguments of a host call are larger than MAX_HOST_CALL_ARG_CHARS. */
class ArgsTooLarge extends Error {}

/**
 * Reads the arguments of a host call into plain values, as `vm.dump()`
 * does. Stops with ArgsTooLarge when the arguments are larger than `max`
 * characters. The engine can call guest code (`toJSON`).
 */
function dumpArgs(vm: QuickJSAsyncContext, handles: QuickJSHandle[], max: number): unknown[] {
  let used = 0;
  const charge = (chars: number): void => {
    used += chars;
    if (used > max) throw new ArgsTooLarge();
  };
  const dumpOne = (handle: QuickJSHandle): unknown => {
    const type = vm.typeof(handle);
    if (type === 'string') {
      // Examine the length before the string is copied into the worker.
      // `getLength()` accepts only objects, thus read the property.
      const length = vm.getProp(handle, 'length');
      try {
        charge(vm.getNumber(length));
      } finally {
        length.dispose();
      }
      return vm.getString(handle);
    }
    if (type === 'number') return vm.getNumber(handle);
    if (type === 'undefined') return undefined;
    // The worker copies a bigint or a symbol before it measures it, as it
    // does for JSON. The memory limit of the engine bounds that copy.
    if (type === 'bigint') {
      const value = vm.getBigInt(handle);
      charge(value.toString().length);
      return value;
    }
    if (type === 'symbol') {
      const value = vm.getSymbol(handle);
      charge(value.description?.length ?? 0);
      return value;
    }
    const state = vm.getPromiseState(handle);
    if (state.type === 'pending') return { type: 'pending' };
    if (state.type === 'rejected') {
      try {
        return { type: 'rejected', error: dumpOne(state.error) };
      } finally {
        if (state.error.alive) state.error.dispose();
      }
    }
    if (!state.notAPromise) {
      try {
        return { type: 'fulfilled', value: dumpOne(state.value) };
      } finally {
        if (state.value.alive) state.value.dispose();
      }
    }
    const text = dumpJson(vm, handle);
    charge(text.length);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  return handles.map(dumpOne);
}

interface CapabilityBridgeSpec {
  name: string;
  stub: CapabilityStubInfo;
  /** Guest JS evaluated after bridge injection (for example, fetch's response wrapper). */
  setupScript?: string;
}

/**
 * Injects the guest-facing API of a host-backed capability into a VM. It
 * injects one asyncified function per stubInfo method/global. Each
 * function relays its dumped args to `invoke` and marshals the plain
 * result back into VM handles. The worker uses this function and relays
 * over postMessage to the main thread. Capability specs also use it and
 * call invokeHost directly.
 *
 * A call fails with a guest error when `gate` tells that the engine cannot
 * suspend, when its arguments are larger than MAX_HOST_CALL_ARG_CHARS, or
 * when `inTime` returns false before the bridge reads the arguments.
 */
export function injectCapabilityBridge(
  vm: QuickJSAsyncContext,
  spec: CapabilityBridgeSpec,
  invoke: (method: string, args: unknown[]) => Promise<unknown>,
  gate: SuspendGate,
  inTime: () => boolean = () => true,
): void {
  const makeBridgeFn = (fnName: string): QuickJSHandle =>
    // The engine also accepts a result that is not a promise. Then the
    // engine does not suspend. The type of newAsyncifiedFunction does not
    // show this, thus the cast.
    vm.newAsyncifiedFunction(fnName, ((...handles: QuickJSHandle[]) => {
      // When the engine cannot suspend here, fail at once. Do not return
      // a promise: the engine cannot wait for it.
      if (!gate.open) {
        return {
          error: vm.newError(
            `${fnName}() cannot run here: a host call cannot suspend the engine in this place.`,
          ),
        };
      }
      // Do not read the arguments after the deadline. The read can be
      // slow, and the run is out of time.
      if (!inTime()) return { error: vm.newError(TIMEOUT_MSG) };
      // Dumping an argument can call guest code (toJSON). A host call
      // from that code cannot suspend, thus the gate is closed for it.
      let args: unknown[];
      try {
        args = gate.hostOnly(() => dumpArgs(vm, handles, MAX_HOST_CALL_ARG_CHARS));
      } catch (e) {
        if (!(e instanceof ArgsTooLarge)) throw e;
        return {
          error: vm.newError({
            name: 'RangeError',
            message: `${fnName}(): the host call arguments exceed ${MAX_HOST_CALL_ARG_CHARS} characters`,
          }),
        };
      }
      return relay(fnName, args);
    }) as AsyncFunctionImplementation);

  // The VM is suspended during the async relay (Asyncify), so only
  // handle creation is allowed here. Do not use vm.evalCode.
  const relay = async (
    fnName: string,
    args: unknown[],
  ): Promise<{ value: QuickJSHandle } | { error: QuickJSHandle }> => {
    try {
      const value = await invoke(fnName, args);
      return { value: marshal(vm, value) };
    } catch (e) {
      return { error: vm.newError(e instanceof Error ? e.message : String(e)) };
    }
  };

  if (spec.stub.type === 'function') {
    for (const fnName of spec.stub.globals ?? [spec.stub.name]) {
      const fn = makeBridgeFn(fnName);
      vm.setProp(vm.global, fnName, fn);
      fn.dispose();
    }
  } else {
    const obj = vm.newObject();
    for (const method of spec.stub.methods ?? []) {
      const fn = makeBridgeFn(method);
      vm.setProp(obj, method, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, spec.stub.name, obj);
    obj.dispose();
  }

  if (spec.setupScript) {
    const setupResult = vm.evalCode(spec.setupScript);
    if ('error' in setupResult && setupResult.error) {
      const errHandle = setupResult.error;
      const err = vm.dump(errHandle);
      if (errHandle.alive) errHandle.dispose();
      throw new Error(`capability '${spec.name}' setup failed: ${JSON.stringify(err)}`);
    }
    if ('value' in setupResult && setupResult.value.alive) {
      setupResult.value.dispose();
    }
  }
}

/**
 * Builds a VM handle from a plain structured-clone value. Safe to call
 * while the VM is asyncify-suspended (handle creation only, no eval).
 * Static handles (undefined/null/true/false) have a no-op dispose. Thus
 * callers can dispose the result in all cases.
 */
function marshal(vm: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === undefined) return vm.undefined;
  if (value === null) return vm.null;
  if (typeof value === 'string') return vm.newString(value);
  if (typeof value === 'number') return vm.newNumber(value);
  if (typeof value === 'boolean') return value ? vm.true : vm.false;
  if (Array.isArray(value)) {
    const arr = vm.newArray();
    value.forEach((v, i) => {
      const h = marshal(vm, v);
      vm.setProp(arr, i, h);
      h.dispose();
    });
    return arr;
  }
  if (typeof value === 'object') {
    const obj = vm.newObject();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const h = marshal(vm, v);
      vm.setProp(obj, k, h);
      h.dispose();
    }
    return obj;
  }
  return vm.undefined;
}
