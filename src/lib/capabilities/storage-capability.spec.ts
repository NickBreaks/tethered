import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { StorageCapability, MapStorageBackend, LocalStorageBackend } from './storage-capability.js';
import { injectCapabilityBridge } from '../../workers/capability-bridge.js';
import { SuspendGate } from '../../workers/engine-async.js';
import type { SandboxCapability } from './capability.js';

// Injects the capability's guest API the way the worker does: bridge
// functions that relay to invokeHost on the (test) main thread.
const gate = new SuspendGate();
function injectCap(vm: QuickJSAsyncContext, cap: SandboxCapability): void {
  injectCapabilityBridge(
    vm,
    { name: cap.name, stub: cap.stubInfo, setupScript: cap.setupScript },
    (method, args) => cap.invokeHost!(method, args),
    gate,
  );
}

// Evaluates guest code the way the worker does: the gate is open, thus a
// host call can suspend the engine.
function evalAsync(vm: QuickJSAsyncContext, code: string) {
  return gate.suspendable(() => vm.evalCodeAsync(code));
}

describe('StorageCapability', () => {
  let module: QuickJSAsyncWASMModule;
  let backend: MapStorageBackend;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  }, 30000);

  beforeEach(() => {
    backend = new MapStorageBackend();
    runtime = module.newRuntime();
    vm = runtime.newContext();
  });

  afterEach(() => {
    try {
      vm.dispose();
    } catch {}
    try {
      runtime.dispose();
    } catch {}
  });

  async function evalAndDump(code: string): Promise<unknown> {
    const result = await evalAsync(vm, code);
    if ('value' in result) {
      const val = vm.dump(result.value);
      result.value.dispose();
      return val;
    }
    const err = vm.dump(result.error);
    result.error.dispose();
    throw new Error(`Eval failed: ${JSON.stringify(err)}`);
  }

  // Test 1: setItem then getItem returns stored value
  it('should store and retrieve a value', async () => {
    const cap = new StorageCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
        storage.setItem('key', 'value');
        storage.getItem('key');
      `);
    expect(val).toBe('value');
    expect(backend.getItem('key')).toBe('value');
  });

  // Test 2: getItem for nonexistent key returns null
  it('should return null for nonexistent key', async () => {
    const cap = new StorageCapability(backend);
    injectCap(vm, cap);
    expect(await evalAndDump(`storage.getItem('missing')`)).toBeNull();
  });

  // Test 3: removeItem causes getItem to return null
  it('should remove a stored value', async () => {
    const cap = new StorageCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
        storage.setItem('key', 'value');
        storage.removeItem('key');
        storage.getItem('key');
      `);
    expect(val).toBeNull();
  });

  // Test 4: Data persists across two sequential inject + evalCodeAsync calls (same backend)
  it('should persist data across executions', async () => {
    const cap = new StorageCapability(backend);
    // First execution
    injectCap(vm, cap);
    await evalAndDump(`storage.setItem('persist', 'yes')`);

    // Dispose and recreate context (this simulates a new execution)
    try {
      vm.dispose();
    } catch {}
    try {
      runtime.dispose();
    } catch {}
    runtime = module.newRuntime();
    vm = runtime.newContext();

    // Second execution with same backend
    injectCap(vm, cap);
    expect(await evalAndDump(`storage.getItem('persist')`)).toBe('yes');
  });

  // Test 5: LocalStorageBackend prepends __sandbox_storage__: prefix
  describe('should namespace localStorage keys', () => {
    // The test environment does not always supply localStorage. Thus
    // each test uses a fake that keeps the items in a map.
    let items: Map<string, string>;

    beforeEach(() => {
      items = new Map();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
        get length() {
          return items.size;
        },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('setItem/getItem/removeItem use the __sandbox_storage__: prefix', () => {
      const lsBackend = new LocalStorageBackend();
      lsBackend.setItem('test', 'value');
      expect(localStorage.getItem('__sandbox_storage__:test')).toBe('value');
      expect(localStorage.getItem('test')).toBeNull();
      expect(lsBackend.getItem('test')).toBe('value');

      // A key without the prefix is not visible to the backend.
      localStorage.setItem('other', 'host');
      expect(lsBackend.getItem('other')).toBeNull();

      lsBackend.removeItem('test');
      expect(localStorage.getItem('__sandbox_storage__:test')).toBeNull();
      expect(localStorage.getItem('other')).toBe('host');
    });
  });

  // Test 6: setItem with non-string value throws error
  it('should error on non-string value for setItem', async () => {
    const cap = new StorageCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
        try {
          storage.setItem('key', 123);
          'no error';
        } catch (e) {
          e.message;
        }
      `);
    expect(val).toContain('value must be a string');
    expect(backend.getItem('key')).toBeNull();
  });

  it('invokeHost() rejects an unknown method', async () => {
    const cap = new StorageCapability(backend);
    await expect(cap.invokeHost('clear', [])).rejects.toThrow('storage.clear is not implemented');
  });
}, 30000);
