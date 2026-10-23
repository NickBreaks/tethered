export const SANDBOX_DISK_DB_NAME = '__sandbox_disk__';
/** Version 1 has one store: `files`. */
export const SANDBOX_DISK_DB_VERSION = 1;
export const FILES_STORE = 'files';

export function openSandboxDisk(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SANDBOX_DISK_DB_NAME, SANDBOX_DISK_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('openSandboxDisk: upgrade blocked'));
  });
}
