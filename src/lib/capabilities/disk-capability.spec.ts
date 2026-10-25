import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { DiskCapability, MapDiskBackend, normalizePath } from './disk-capability.js';
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
    const result = await evalAsync(vm, code);
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
    `) as string[];
    expect([...val].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('listFiles() with no argument lists the root', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/a.txt', 'a');
      disk.writeFile('/dir/b.txt', 'b');
      disk.listFiles();
    `) as string[];
    expect([...val].sort()).toEqual(['a.txt', 'dir/']);
  });

  it.each([[''], ['.'], ['/'], ['/..'], ['a/..'], ['//./']])(
    'writeFile and readFile refuse the path %j, which normalizes to the root',
    async (path) => {
      const cap = new DiskCapability(backend);
      const msg = "EINVAL: invalid path: a file path must not be the root '/'";
      await expect(cap.invokeHost('writeFile', [path, 'hidden'])).rejects.toThrow(new Error(msg));
      await expect(cap.invokeHost('readFile', [path])).rejects.toThrow(new Error(msg));
      expect(await backend.list()).toEqual([]);
    },
  );

  it('the guest gets the root path error from writeFile', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      try {
        disk.writeFile('/..', 'hidden');
        'no error';
      } catch (e) {
        e.message;
      }
    `);
    expect(val).toBe("EINVAL: invalid path: a file path must not be the root '/'");
  });

  it('should list direct children of subdirectory', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/data/hello.txt', 'Hello');
      disk.writeFile('/data/sub/nested.txt', 'Nested');
      disk.writeFile('/data/sub/other.txt', 'Other');
      disk.writeFile('/database.txt', 'not a child');
      disk.listFiles('/data');
    `) as string[];
    // A subdirectory shows one time. A sibling with the same prefix does not show.
    expect([...val].sort()).toEqual(['hello.txt', 'sub/']);
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
    const r1 = await evalAsync(vm, `disk.writeFile('/persist.txt', 'data')`);
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

  it('MapDiskBackend.delete round-trips (write -> delete -> read undefined)', async () => {
    const map = new MapDiskBackend();
    await map.write('/f.txt', 'x');
    await map.delete('/f.txt');
    expect(await map.read('/f.txt')).toBeUndefined();
  });

  it('MapDiskBackend.delete on non-existent path is a no-op (no throw)', async () => {
    const map = new MapDiskBackend();
    await expect(map.delete('/nope.txt')).resolves.toBeUndefined();
  });

  // The last case shows that only exact '.' and '..' segments are special.
  it.each([
    ['/a/../b', '/b'],
    ['/a/./b/', '/a/b'],
    ['a//b/../c', '/a/c'],
    ['/../x', '/x'],
    ['../../x/..', '/'],
    ['/a/b/../../..', '/'],
    ['', '/'],
    ['.', '/'],
    ['/a/.../..b/.c', '/a/.../..b/.c'],
  ])(
    'normalizePath resolves . and .. segments and never goes above the root: %j -> %j',
    (input, expected) => {
      expect(normalizePath(input)).toBe(expected);
    },
  );

  it('invokeHost() rejects an unknown method', async () => {
    const cap = new DiskCapability(backend);
    await expect(cap.invokeHost('deleteFile', ['/a.txt'])).rejects.toThrow(
      'disk.deleteFile is not implemented',
    );
  });

  it('a path with .. reads and writes the same file as its resolved form', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/a/../b.txt', 'one');
      disk.writeFile('/../../c.txt', 'two');
      [disk.readFile('/b.txt'), disk.readFile('./c.txt')];
    `);
    expect(val).toEqual(['one', 'two']);
    expect((await backend.list()).sort()).toEqual(['/b.txt', '/c.txt']);
  });

  it('listFiles skips backend keys that are not strings', async () => {
    // An IndexedDB store can hold number, date or array keys that the host wrote.
    const keys: unknown[] = [1, new Date(0), ['/a'], '/file.txt', '/dir/x.txt'];
    const cap = new DiskCapability({
      read: async () => undefined,
      write: async () => {},
      list: async () => keys as string[],
    });
    const listed = (await cap.invokeHost('listFiles', ['/'])) as string[];
    expect([...listed].sort()).toEqual(['dir/', 'file.txt']);
  });

  it('listFiles resolves . and .. in the directory path', async () => {
    const cap = new DiskCapability(backend);
    injectCap(vm, cap);
    const val = await evalAndDump(`
      disk.writeFile('/top.txt', 'x');
      disk.writeFile('/data/hello.txt', 'Hello');
      disk.writeFile('/data/sub/nested.txt', 'Nested');
      [disk.listFiles('/data/sub/..'), disk.listFiles('/data/./sub/'), disk.listFiles('/..')];
    `) as string[][];
    expect([...val[0]!].sort()).toEqual(['hello.txt', 'sub/']);
    expect(val[1]).toEqual(['nested.txt']);
    expect([...val[2]!].sort()).toEqual(['data/', 'top.txt']);
  });
}, 30_000);
