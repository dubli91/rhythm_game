// IndexedDB access for practice patterns (practice-mode.md). Database `prismbeat`
// holds one store: `practicePatterns` (keyPath 'patternId'). The former `songs`/
// `audio` stores served the BMS-import feature descoped 2026-07-16 and are no
// longer created; a v1 database from an old build may still carry them, empty and
// unreferenced, which is harmless (onupgradeneeded only runs on a version bump).
//
// Quota/write failures are surfaced as StorageQuotaError so callers can show a
// distinct "storage full" notice instead of a generic error.
//
// This module owns no connection state — the app shell is responsible for opening the
// database once and holding onto the IDBDatabase for its lifetime.

export const DB_NAME = 'prismbeat';
export const DB_VERSION = 1;

export const STORES = {
  practicePatterns: 'practicePatterns',
} as const;

export class StorageQuotaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageQuotaError';
  }
}

/** Picks the first candidate DOMException/Error; promotes a QuotaExceededError name to StorageQuotaError. */
function toStorageError(...candidates: Array<DOMException | Error | null | undefined>): Error {
  const quotaError = candidates.find(
    (candidate): candidate is DOMException =>
      candidate instanceof DOMException && candidate.name === 'QuotaExceededError',
  );
  if (quotaError) {
    return new StorageQuotaError(quotaError.message || 'IndexedDB storage quota exceeded', {
      cause: quotaError,
    });
  }

  const primary = candidates.find((candidate) => candidate != null);
  if (primary instanceof Error) {
    return primary;
  }
  return new Error('IndexedDB operation failed', { cause: primary });
}

function ensureStore(db: IDBDatabase, name: string, options?: IDBObjectStoreParameters): void {
  if (!db.objectStoreNames.contains(name)) {
    db.createObjectStore(name, options);
  }
}

/** Opens (creating/upgrading stores as needed). factory defaults to globalThis.indexedDB; tests pass fake-indexeddb's. */
export function openDatabase(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      ensureStore(request.result, STORES.practicePatterns, { keyPath: 'patternId' });
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(toStorageError(request.error));
    };
  });
}

/** Wraps a single request's lifecycle plus its owning transaction into one Promise. */
function promisifyRequest<T>(tx: IDBTransaction, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    let settled = false;

    function fail(): void {
      if (settled) return;
      settled = true;
      reject(toStorageError(request.error, tx.error));
    }

    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = fail;

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export function idbGet<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const tx = db.transaction(store, 'readonly');
  const request = tx.objectStore(store).get(key);
  return promisifyRequest<T | undefined>(tx, request);
}

export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  const tx = db.transaction(store, 'readonly');
  const request = tx.objectStore(store).getAll();
  return promisifyRequest<T[]>(tx, request);
}

export function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const request = tx.objectStore(store).put(value);
  return promisifyRequest<IDBValidKey>(tx, request).then(() => undefined);
}

export function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const request = tx.objectStore(store).delete(key);
  return promisifyRequest<undefined>(tx, request).then(() => undefined);
}
