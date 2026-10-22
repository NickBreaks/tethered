import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten-core';
import type { CapabilityStubInfo } from '../index.js';

export interface CapabilityBridgeSpec {
  name: string;
  stub: CapabilityStubInfo;
  /** Guest JS evaluated after bridge injection (e.g. fetch's response wrapper). */
  setupScript?: string;
}

/**
 * Injects the guest-facing API of a host-backed capability into a VM:
 * one asyncified function per stubInfo method/global, each relaying its
 * dumped args to `invoke` and marshaling the plain result back into VM
 * handles. Used by the worker (relaying over postMessage to the main
 * thread) and by capability specs (calling invokeHost directly).
 */
export function injectCapabilityBridge(
  vm: QuickJSAsyncContext,
  spec: CapabilityBridgeSpec,
  invoke: (method: string, args: unknown[]) => Promise<unknown>,
): void {
  const makeBridgeFn = (fnName: string): QuickJSHandle =>
    vm.newAsyncifiedFunction(fnName, async (...handles: QuickJSHandle[]) => {
      // The VM is suspended during the async relay (Asyncify), so only
      // handle creation is allowed here — no vm.evalCode.
      const args = handles.map((h) => vm.dump(h));
      try {
        const value = await invoke(fnName, args);
        return { value: marshal(vm, value) };
      } catch (e) {
        return { error: vm.newError(e instanceof Error ? e.message : String(e)) };
      }
    });

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
 * Static handles (undefined/null/true/false) have no-op dispose, so
 * callers may uniformly dispose the result.
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
