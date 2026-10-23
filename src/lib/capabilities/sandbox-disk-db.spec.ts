import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSandboxDisk,
  SANDBOX_DISK_DB_VERSION,
  FILES_STORE,
  SANDBOX_DISK_DB_NAME,
} from './sandbox-disk-db.js';

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function countEntries(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IndexedDB is not available in the node/jsdom unit-test runner. These tests
// must have a real IDB and run only when it is present. The browser
// integration suite (vitest.integration.config.ts) runs them in Chromium.
const hasIndexedDB = typeof indexedDB !== 'undefined';

describe.skipIf(!hasIndexedDB)('openSandboxDisk', () => {
  beforeEach(async () => {
    await deleteDb(SANDBOX_DISK_DB_NAME);
  });

  afterEach(async () => {
    await deleteDb(SANDBOX_DISK_DB_NAME);
  });

  it('cold-open against a fresh browser creates only the files store', async () => {
    const db = await openSandboxDisk();
    try {
      expect(db.version).toBe(SANDBOX_DISK_DB_VERSION);
      expect(SANDBOX_DISK_DB_VERSION).toBe(1);
      expect(Array.from(db.objectStoreNames)).toEqual([FILES_STORE]);
      expect(await countEntries(db, FILES_STORE)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('two concurrent openSandboxDisk() calls both resolve to usable handles', async () => {
    const [a, b] = await Promise.all([openSandboxDisk(), openSandboxDisk()]);
    try {
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a.objectStoreNames.contains(FILES_STORE)).toBe(true);
      expect(b.objectStoreNames.contains(FILES_STORE)).toBe(true);
      // Both handles are independently usable
      expect(await countEntries(a, FILES_STORE)).toBe(0);
      expect(await countEntries(b, FILES_STORE)).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
