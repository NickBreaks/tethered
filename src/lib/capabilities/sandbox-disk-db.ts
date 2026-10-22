export const SANDBOX_DISK_DB_NAME = '__sandbox_disk__';
export const SANDBOX_DISK_DB_VERSION = 2;
export const FILES_STORE = 'files';
export const WRITE_JOURNAL_STORE = 'write_journal';

export function openSandboxDisk(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SANDBOX_DISK_DB_NAME, SANDBOX_DISK_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE);
      }
      if (!db.objectStoreNames.contains(WRITE_JOURNAL_STORE)) {
        const journal = db.createObjectStore(WRITE_JOURNAL_STORE, { keyPath: 'id' });
        journal.createIndex('by_path', 'path', { unique: false });
        journal.createIndex('by_timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('openSandboxDisk: upgrade blocked'));
  });
}
