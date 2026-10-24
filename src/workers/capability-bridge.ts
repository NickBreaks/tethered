import type {
  AsyncFunctionImplementation,
  QuickJSAsyncContext,
  QuickJSHandle,
} from 'quickjs-emscripten-core';
import type { CapabilityStubInfo } from '../lib/capabilities/capability.js';
import type { SuspendGate } from './engine-async.js';

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
 * suspend.
 */
export function injectCapabilityBridge(
  vm: QuickJSAsyncContext,
  spec: CapabilityBridgeSpec,
  invoke: (method: string, args: unknown[]) => Promise<unknown>,
  gate: SuspendGate,
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
      // Dumping an argument can call guest code (toJSON). A host call
      // from that code cannot suspend, thus the gate is closed for it.
      const dumpArgs = (): unknown[] => handles.map((h) => vm.dump(h));
      const args = gate.hostOnly(dumpArgs);
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
