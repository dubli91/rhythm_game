// IndexedDB access for the song library and practice patterns (song-library.md,
// practice-mode.md). Database `iidx-web` holds three stores: `songs` (metadata + charts,
// keyPath 'songId'), `audio` (out-of-line Blob keyed by songId), and `practicePatterns`
// (keyPath 'patternId').
//
// Per-song atomicity (song-library.md MUST 8): putSongAtomic writes the audio blob and the
// song metadata in a single readwrite transaction, metadata last, so a mid-import failure can
// never leave a half-complete song visible. deleteSong removes both records together for the
// same reason.
//
// Quota/write failures are surfaced as StorageQuotaError (song-library.md MUST 8) so the app
// shell can show a distinct "storage full" notice instead of a generic error.
//
// This module owns no connection state — the app shell is responsible for opening the
// database once and holding onto the IDBDatabase for its lifetime.

import type { Song } from '../chart/types';

export const DB_NAME = 'iidx-web';
export const DB_VERSION = 1;

export const STORES = {
  songs: 'songs',
  audio: 'audio',
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
      const db = request.result;
      ensureStore(db, STORES.songs, { keyPath: 'songId' });
      ensureStore(db, STORES.audio);
      ensureStore(db, STORES.practicePatterns, { keyPath: 'patternId' });
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

export function idbGetAllKeys(db: IDBDatabase, store: string): Promise<IDBValidKey[]> {
  const tx = db.transaction(store, 'readonly');
  const request = tx.objectStore(store).getAllKeys();
  return promisifyRequest<IDBValidKey[]>(tx, request);
}

export function idbPut(
  db: IDBDatabase,
  store: string,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  const request = key === undefined ? objectStore.put(value) : objectStore.put(value, key);
  return promisifyRequest<IDBValidKey>(tx, request).then(() => undefined);
}

export function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const request = tx.objectStore(store).delete(key);
  return promisifyRequest<undefined>(tx, request).then(() => undefined);
}

/**
 * Writes the audio blob first, then the song metadata, in ONE readwrite transaction over
 * [songs, audio]. Resolves on transaction 'complete' (both writes durable); rejects on
 * 'error'/'abort' with neither write surviving. audioBlob may be null for songs whose audio
 * lives elsewhere (e.g. builtin songs are never written through this path, but the signature
 * stays uniform for future callers).
 */
export function putSongAtomic(db: IDBDatabase, song: Song, audioBlob: Blob | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.songs, STORES.audio], 'readwrite');
    let settled = false;
    let requestError: DOMException | Error | null | undefined;

    function fail(): void {
      if (settled) return;
      settled = true;
      reject(toStorageError(requestError, tx.error));
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = fail;
    tx.onabort = fail;

    try {
      if (audioBlob !== null) {
        const audioRequest = tx.objectStore(STORES.audio).put(audioBlob, song.songId);
        audioRequest.onerror = () => {
          requestError = audioRequest.error;
        };
      }

      const songsRequest = tx.objectStore(STORES.songs).put(song);
      songsRequest.onerror = () => {
        requestError = songsRequest.error;
      };
    } catch (error) {
      requestError = error instanceof Error ? error : new Error(String(error));
      tx.abort();
    }
  });
}

/** Removes the song's metadata and audio blob in ONE transaction — both gone, or neither. */
export function deleteSong(db: IDBDatabase, songId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.songs, STORES.audio], 'readwrite');
    let settled = false;
    let requestError: DOMException | Error | null | undefined;

    function fail(): void {
      if (settled) return;
      settled = true;
      reject(toStorageError(requestError, tx.error));
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = fail;
    tx.onabort = fail;

    try {
      const songsRequest = tx.objectStore(STORES.songs).delete(songId);
      songsRequest.onerror = () => {
        requestError = songsRequest.error;
      };

      const audioRequest = tx.objectStore(STORES.audio).delete(songId);
      audioRequest.onerror = () => {
        requestError = audioRequest.error;
      };
    } catch (error) {
      requestError = error instanceof Error ? error : new Error(String(error));
      tx.abort();
    }
  });
}
