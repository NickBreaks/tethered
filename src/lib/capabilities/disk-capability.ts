import type { SandboxCapability, CapabilityStubInfo } from './capability.js';
import { FILES_STORE, openSandboxDisk } from './sandbox-disk-db.js';

export interface DiskBackend {
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  list(): Promise<string[]>;
  /**
   * Optional. `DiskCapability` does not call it, because the guest API has
   * no delete. Idempotent: a no-op when the path is absent.
   */
  delete?(path: string): Promise<void>;
}

/**
 * Keeps the files in the `__sandbox_disk__` IndexedDB database. The backend
 * opens one connection on the first call and keeps it. It closes the
 * connection when a different connection must upgrade or delete the
 * database, and opens a new one on the next call. Each operation settles
 * when its transaction completes, thus an aborted write is an error.
 */
export class IndexedDBDiskBackend implements DiskBackend {
  #db: Promise<IDBDatabase> | null = null;

  async read(path: string): Promise<string | undefined> {
    const value = await this.#request<unknown>('readonly', (store) => store.get(path));
    return value === undefined ? undefined : (value as string);
  }

  async write(path: string, content: string): Promise<void> {
    await this.#request('readwrite', (store) => store.put(content, path));
  }

  async list(): Promise<string[]> {
    return (await this.#request('readonly', (store) => store.getAllKeys())) as string[];
  }

  async delete(path: string): Promise<void> {
    await this.#request('readwrite', (store) => store.delete(path));
  }

  /** Closes the connection. The next operation opens a new connection. */
  close(): void {
    const db = this.#db;
    this.#db = null;
    void db?.then(
      (d) => d.close(),
      () => {},
    );
  }

  #open(): Promise<IDBDatabase> {
    if (this.#db) return this.#db;
    const opening = openSandboxDisk().then((db) => {
      // An open connection blocks an upgrade or a delete from a different
      // connection, for example in a different tab. Release it.
      const forget = () => {
        if (this.#db === opening) this.#db = null;
      };
      db.onversionchange = () => {
        db.close();
        forget();
      };
      // The browser can also close the connection, for example when the
      // user clears the site data.
      db.onclose = forget;
      return db;
    });
    // A failed open is not kept. The next operation tries again.
    opening.catch(() => {
      if (this.#db === opening) this.#db = null;
    });
    this.#db = opening;
    return opening;
  }

  async #request<T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FILES_STORE, mode);
      const req = op(tx.objectStore(FILES_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error ?? new Error('disk: the transaction was aborted.'));
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

/**
 * Makes the record key of a file from a guest argument. It throws for a
 * path that normalizes to the root `/`, for example `''`, `.` or `/..`.
 * `listFiles` never shows a file at the root key. Thus a guest cannot
 * use that key to hide a file.
 */
function filePath(arg: unknown): string {
  const path = normalizePath(String(arg));
  if (path === '/') throw new Error("EINVAL: invalid path: a file path must not be the root '/'");
  return path;
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
        const path = filePath(args[0]);
        await this.backend.write(path, String(args[1]));
        return undefined;
      }
      case 'readFile': {
        const path = filePath(args[0]);
        const content = await this.backend.read(path);
        if (content === undefined) {
          throw new Error(`ENOENT: no such file: '${path}'`);
        }
        return content;
      }
      case 'listFiles': {
        // listFiles() with no argument lists the root. This is the only
        // path argument that does not go through String().
        const dirPath = args[0] === undefined ? '/' : normalizePath(String(args[0]));
        const allPaths = await this.backend.list();
        const prefix = dirPath === '/' ? '/' : dirPath + '/';

        // Find direct children of the directory
        const children = new Set<string>();
        for (const filePath of allPaths as unknown[]) {
          // The host can write keys that are not strings, for example
          // numbers in IndexedDB. The guest cannot use them. Skip them.
          if (typeof filePath !== 'string' || !filePath.startsWith(prefix)) continue;
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
