import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSandboxDisk,
  SANDBOX_DISK_DB_VERSION,
  FILES_STORE,
  WRITE_JOURNAL_STORE,
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

function openV1LegacyOnly(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SANDBOX_DISK_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

  it('cold-open against a fresh browser creates files and write_journal stores', async () => {
    const db = await openSandboxDisk();
    try {
      expect(db.version).toBe(SANDBOX_DISK_DB_VERSION);
      expect(db.objectStoreNames.contains(FILES_STORE)).toBe(true);
      expect(db.objectStoreNames.contains(WRITE_JOURNAL_STORE)).toBe(true);
      // The journal store must be empty (count() is in the subset of IDB that jsdom supports)
      expect(await countEntries(db, WRITE_JOURNAL_STORE)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('cold-open: write_journal has by_path and by_timestamp indexes', async () => {
    // jsdom's IDB is partial. Skip if the index assertion surface is not available.
    // If this runs in jsdom and the schema API is incomplete, guard here. Browser mode
    // runs it fully.
    const db = await openSandboxDisk();
    try {
      const tx = db.transaction(WRITE_JOURNAL_STORE, 'readonly');
      const store = tx.objectStore(WRITE_JOURNAL_STORE);
      expect(Array.from(store.indexNames)).toEqual(
        expect.arrayContaining(['by_path', 'by_timestamp']),
      );
      const byPath = store.index('by_path');
      const byTs = store.index('by_timestamp');
      expect(byPath.keyPath).toBe('path');
      expect(byPath.unique).toBe(false);
      expect(byTs.keyPath).toBe('timestamp');
      expect(byTs.unique).toBe(false);
      expect(store.keyPath).toBe('id');
    } finally {
      db.close();
    }
  });

  it('warm-open against an existing v1 DB upgrades to v2 and adds write_journal', async () => {
    const v1 = await openV1LegacyOnly();
    expect(v1.version).toBe(1);
    expect(v1.objectStoreNames.contains(FILES_STORE)).toBe(true);
    expect(v1.objectStoreNames.contains(WRITE_JOURNAL_STORE)).toBe(false);
    v1.close();

    const upgraded = await openSandboxDisk();
    try {
      expect(upgraded.version).toBe(SANDBOX_DISK_DB_VERSION);
      expect(upgraded.objectStoreNames.contains(FILES_STORE)).toBe(true);
      expect(upgraded.objectStoreNames.contains(WRITE_JOURNAL_STORE)).toBe(true);
    } finally {
      upgraded.close();
    }
  });

  it('two concurrent openSandboxDisk() calls both resolve to usable handles', async () => {
    const [a, b] = await Promise.all([openSandboxDisk(), openSandboxDisk()]);
    try {
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a.objectStoreNames.contains(WRITE_JOURNAL_STORE)).toBe(true);
      expect(b.objectStoreNames.contains(WRITE_JOURNAL_STORE)).toBe(true);
      // Both handles are independently usable
      expect(await countEntries(a, WRITE_JOURNAL_STORE)).toBe(0);
      expect(await countEntries(b, WRITE_JOURNAL_STORE)).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });
});
