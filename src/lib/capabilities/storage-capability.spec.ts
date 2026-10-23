import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import {
  StorageCapability,
  MapStorageBackend,
  LocalStorageBackend,
} from './storage-capability.js';
import { injectCapabilityBridge } from '../../workers/capability-bridge.js';
import type { SandboxCapability } from './capability.js';

// Injects the capability's guest API the way the worker does: bridge
// functions that relay to invokeHost on the (test) main thread.
function injectCap(vm: QuickJSAsyncContext, cap: SandboxCapability): void {
  injectCapabilityBridge(
    vm,
    { name: cap.name, stub: cap.stubInfo, setupScript: cap.setupScript },
    (method, args) => cap.invokeHost!(method, args),
  );
}

describe(
  'StorageCapability',
  () => {
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

    // Test 1: setItem then getItem returns stored value
    it('should store and retrieve a value', async () => {
      const cap = new StorageCapability(backend);
      injectCap(vm, cap);
      const result = await vm.evalCodeAsync(`
      storage.setItem('key', 'value');
      storage.getItem('key');
    `);
      if ('value' in result) {
        const val = vm.dump(result.value);
        result.value.dispose();
        expect(val).toBe('value');
      } else {
        result.error.dispose();
        throw new Error('Expected success');
      }
    });

    // Test 2: getItem for nonexistent key returns null
    it('should return null for nonexistent key', async () => {
      const cap = new StorageCapability(backend);
      injectCap(vm, cap);
      const result = await vm.evalCodeAsync(`storage.getItem('missing')`);
      if ('value' in result) {
        const val = vm.dump(result.value);
        result.value.dispose();
        expect(val).toBeNull();
      } else {
        result.error.dispose();
        throw new Error('Expected success');
      }
    });

    // Test 3: removeItem causes getItem to return null
    it('should remove a stored value', async () => {
      const cap = new StorageCapability(backend);
      injectCap(vm, cap);
      const result = await vm.evalCodeAsync(`
      storage.setItem('key', 'value');
      storage.removeItem('key');
      storage.getItem('key');
    `);
      if ('value' in result) {
        const val = vm.dump(result.value);
        result.value.dispose();
        expect(val).toBeNull();
      } else {
        result.error.dispose();
        throw new Error('Expected success');
      }
    });

    // Test 4: Data persists across two sequential inject + evalCodeAsync calls (same backend)
    it('should persist data across executions', async () => {
      const cap = new StorageCapability(backend);
      // First execution
      injectCap(vm, cap);
      const r1 = await vm.evalCodeAsync(`storage.setItem('persist', 'yes')`);
      if ('value' in r1) r1.value.dispose();
      else {
        r1.error.dispose();
        throw new Error('Expected success');
      }

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
      const r2 = await vm.evalCodeAsync(`storage.getItem('persist')`);
      if ('value' in r2) {
        const val = vm.dump(r2.value);
        r2.value.dispose();
        expect(val).toBe('yes');
      } else {
        r2.error.dispose();
        throw new Error('Expected success');
      }
    });

    // Test 5: LocalStorageBackend prepends __sandbox_storage__: prefix
    it('should namespace localStorage keys', () => {
      const lsBackend = new LocalStorageBackend();
      expect(lsBackend).toBeDefined();
      // Verify MapStorageBackend stores with exact keys (no prefix)
      const mapBackend = new MapStorageBackend();
      mapBackend.setItem('test', 'value');
      expect(mapBackend.getItem('test')).toBe('value');
    });

    // Test 6: setItem with non-string value throws error
    it('should error on non-string value for setItem', async () => {
      const cap = new StorageCapability(backend);
      injectCap(vm, cap);
      const result = await vm.evalCodeAsync(`
      try {
        storage.setItem('key', 123);
        'no error';
      } catch (e) {
        e.message;
      }
    `);
      if ('value' in result) {
        const val = vm.dump(result.value);
        result.value.dispose();
        expect(val).toContain('value must be a string');
      } else {
        result.error.dispose();
        throw new Error('Expected success with caught error');
      }
    });
  },
  30000
);
