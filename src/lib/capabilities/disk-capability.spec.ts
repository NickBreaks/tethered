import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { DiskCapability, MapDiskBackend } from './disk-capability.js';
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

describe('DiskCapability', () => {
  let module: QuickJSAsyncWASMModule;
  let backend: MapDiskBackend;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  }, 30_000);

  beforeEach(() => {
    backend = new MapDiskBackend();
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

  it('should write and read a file', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/hello.txt', 'Hello, world!');
      disk.readFile('/hello.txt');
    `);
    expect(val).toBe('Hello, world!');
  });

  it('should throw ENOENT for missing file', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      try {
        disk.readFile('/nonexistent.txt');
        'no error';
      } catch (e) {
        e.message;
      }
    `);
    expect(val).toContain('ENOENT');
    expect(val).toContain('/nonexistent.txt');
  });

  it('should list files', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/a.txt', 'a');
      disk.writeFile('/b.txt', 'b');
      disk.listFiles('/');
    `);
    expect(val).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
  });

  it('should list direct children of subdirectory', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/data/hello.txt', 'Hello');
      disk.writeFile('/data/sub/nested.txt', 'Nested');
      disk.listFiles('/data');
    `);
    expect(val).toEqual(expect.arrayContaining(['hello.txt', 'sub/']));
  });

  it('should overwrite existing file', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/file.txt', 'original');
      disk.writeFile('/file.txt', 'updated');
      disk.readFile('/file.txt');
    `);
    expect(val).toBe('updated');
  });

  it('should normalize paths', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('file.txt', 'content');
      disk.readFile('/file.txt');
    `);
    expect(val).toBe('content');
  });

  it('should persist files across executions', async () => {
    const cap = new DiskCapability(backend);

    // First execution
    injectCap(vm, cap);
    const r1 = await vm.evalCodeAsync(`disk.writeFile('/persist.txt', 'data')`);
    if ('value' in r1) r1.value.dispose();
    else { r1.error.dispose(); throw new Error('Expected success'); }

    // Recreate context
    try { vm.dispose(); } catch { /* ignore */ }
    try { runtime.dispose(); } catch { /* ignore */ }
    runtime = module.newRuntime();
    vm = runtime.newContext();

    // Second execution with same capability/backend
    injectCap(vm, cap);
    const val = await evalAndDump(`disk.readFile('/persist.txt')`);
    expect(val).toBe('data');
  });

  it('should return empty array when no files exist', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`disk.listFiles('/')`);
    expect(val).toEqual([]);
  });

  it('getBackend() returns the same instance passed to the constructor', () => {
    const map = new MapDiskBackend();
    const cap = new DiskCapability(map);
    expect(cap.getBackend()).toBe(map);
    expect(cap.getBackend()).toBeInstanceOf(MapDiskBackend);
  });

  it('A-21: MapDiskBackend.delete round-trips (write -> delete -> read undefined)', async () => {
    const map = new MapDiskBackend();
    await map.write('/f.txt', 'x');
    await map.delete('/f.txt');
    expect(await map.read('/f.txt')).toBeUndefined();
  });

  it('MapDiskBackend.delete on non-existent path is a no-op (no throw)', async () => {
    const map = new MapDiskBackend();
    await expect(map.delete('/nope.txt')).resolves.toBeUndefined();
  });
}, 30_000);
