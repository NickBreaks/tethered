import type { SandboxCapability, CapabilityStubInfo } from './capability.js';
import { openSandboxDisk } from './sandbox-disk-db.js';

export interface DiskBackend {
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  list(): Promise<string[]>;
  /** Idempotent: a no-op when the path is absent. */
  delete(path: string): Promise<void>;
}

export class IndexedDBDiskBackend implements DiskBackend {
  private readonly storeName = 'files';

  private openDB(): Promise<IDBDatabase> {
    return openSandboxDisk();
  }

  async read(path: string): Promise<string | undefined> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(path);
      req.onsuccess = () => resolve(req.result ?? undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async write(path: string, content: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.put(content, path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async list(): Promise<string[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(path: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export class MapDiskBackend implements DiskBackend {
  private readonly store = new Map<string, string>();

  async read(path: string): Promise<string | undefined> {
    return this.store.get(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.store.set(path, content);
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }
}

/**
 * Makes the record key for a disk path. The result is absolute and has no
 * empty, `.` or `..` segments and no trailing slash. A relative path starts
 * at `/`. The function resolves `.` and `..` as POSIX does, but `..` at the
 * root stays at the root. Thus `/a/../b` and `b` both become `/b`, and
 * `/../x` becomes `/x`. Paths are only strings: no real file system is
 * behind them.
 */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return '/' + segments.join('/');
}

export class DiskCapability implements SandboxCapability {
  readonly name = 'disk';
  readonly description = 'Virtual file system via IndexedDB';
  readonly stubInfo: CapabilityStubInfo = {
    name: 'disk',
    type: 'object',
    methods: ['readFile', 'writeFile', 'listFiles'],
  };

  constructor(private backend: DiskBackend = new IndexedDBDiskBackend()) {}

  getBackend(): DiskBackend {
    return this.backend;
  }

  async invokeHost(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'writeFile': {
        const path = normalizePath(String(args[0]));
        await this.backend.write(path, String(args[1]));
        return undefined;
      }
      case 'readFile': {
        const path = normalizePath(String(args[0]));
        const content = await this.backend.read(path);
        if (content === undefined) {
          throw new Error(`ENOENT: no such file: '${path}'`);
        }
        return content;
      }
      case 'listFiles': {
        const dirPath = args[0] === undefined ? '/' : normalizePath(String(args[0]));
        const allPaths = await this.backend.list();
        const prefix = dirPath === '/' ? '/' : dirPath + '/';

        // Find direct children of the directory
        const children = new Set<string>();
        for (const filePath of allPaths) {
          if (!filePath.startsWith(prefix) && filePath !== dirPath) continue;
          const relative = filePath.slice(prefix.length);
          if (!relative) continue;
          const slashIdx = relative.indexOf('/');
          if (slashIdx === -1) {
            children.add(relative);
          } else {
            children.add(relative.slice(0, slashIdx) + '/');
          }
        }
        return [...children];
      }
      default:
        throw new Error(`disk.${method} is not implemented`);
    }
  }
}
