import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexedDBDiskBackend } from './disk-capability.js';
import { SANDBOX_DISK_DB_NAME } from './sandbox-disk-db.js';

/** Deletes the database. It rejects if an open connection blocks the delete. */
function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SANDBOX_DISK_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase is blocked'));
  });
}

describe('IndexedDBDiskBackend', () => {
  let backend: IndexedDBDiskBackend;

  beforeEach(async () => {
    await deleteDb();
    backend = new IndexedDBDiskBackend();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    backend.close();
    await deleteDb();
  });

  it('writes, reads, lists and deletes files', async () => {
    await backend.write('/a.txt', 'A');
    await backend.write('/dir/b.txt', 'B');
    expect(await backend.read('/a.txt')).toBe('A');
    expect(await backend.read('/missing')).toBeUndefined();
    expect((await backend.list()).sort()).toEqual(['/a.txt', '/dir/b.txt']);
    await backend.delete('/a.txt');
    await backend.delete('/missing');
    expect(await backend.list()).toEqual(['/dir/b.txt']);
  });

  it('opens one connection for all operations', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    await Promise.all([backend.write('/a.txt', 'A'), backend.read('/a.txt')]);
    await backend.list();
    await backend.delete('/a.txt');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('releases its connection when a different connection deletes the database', async () => {
    await backend.write('/a.txt', 'A');
    await expect(deleteDb()).resolves.toBeUndefined();
    // The next operation opens a new, empty database.
    expect(await backend.list()).toEqual([]);
    await backend.write('/b.txt', 'B');
    expect(await backend.read('/b.txt')).toBe('B');
  });

  it('closes its connection on close() and opens a new one for the next operation', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const close = vi.spyOn(IDBDatabase.prototype, 'close');
    await backend.write('/a.txt', 'A');
    backend.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(await backend.read('/a.txt')).toBe('A');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('rejects a write when its transaction aborts after the request succeeds', async () => {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const req = put.apply(this, args);
      // This listener runs before the handlers that the backend sets.
      req.addEventListener('success', () => this.transaction.abort());
      return req;
    });
    await expect(backend.write('/a.txt', 'A')).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await backend.read('/a.txt')).toBeUndefined();
  });
});
