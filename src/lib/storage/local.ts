// Single source of truth for localStorage persistence (IMPLEMENTATION_PLAN.md line 32).
// All settings/playOptions/records documents go through createLocalDoc — no ad-hoc
// getItem/setItem elsewhere in the app (settings-screen.md SHOULD 14).
//
// Corrupted or unreadable data must never crash the app: read() always falls back to
// a fresh default (app-shell-navigation.md MUST 5), while readDetailed() reports what
// happened so callers needing more (e.g. the records backup-then-reset prompt in
// results-records.md MUST 9) can react.

/** Minimal Storage surface so tests inject an in-memory fake and the app injects window.localStorage. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_KEYS = {
  settings: 'settings.v1',
  playOptions: 'playOptions.v1',
  records: 'records.v1',
} as const;

export type ReadStatus = 'ok' | 'missing' | 'corrupt' | 'version-mismatch';

export interface ReadResult<T> {
  status: ReadStatus;
  value: T;
  /** raw string preserved when status is 'corrupt' so callers can offer a backup before reset */
  raw?: string;
}

export interface LocalDoc<T> {
  /** Never throws; falls back to defaultValue() on missing/corrupt/unmigratable. */
  read(): T;
  /** Like read() but reports what happened (drives the records backup-then-reset prompt). */
  readDetailed(): ReadResult<T>;
  /** Serializes {version, data}. Storage exceptions (quota) propagate to the caller. */
  write(data: T): void;
  remove(): void;
  readonly key: string;
}

export interface CreateLocalDocOptions<T> {
  storage: KeyValueStorage;
  key: string;
  version: number;
  defaultValue: () => T;
  /** Optional migration for older stored versions; return undefined if unmigratable. */
  migrate?: (storedVersion: number, data: unknown) => T | undefined;
  /** Optional shape check applied after parse/migrate; failing it counts as corrupt. */
  validate?: (data: unknown) => data is T;
}

interface StoredEnvelope {
  version: number;
  data: unknown;
}

function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof (value as Record<string, unknown>).version === 'number'
  );
}

export function createLocalDoc<T>(opts: CreateLocalDocOptions<T>): LocalDoc<T> {
  const { storage, key, version, defaultValue, migrate, validate } = opts;

  function readDetailed(): ReadResult<T> {
    const raw = storage.getItem(key);
    if (raw === null) {
      return { status: 'missing', value: defaultValue() };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'corrupt', value: defaultValue(), raw };
    }

    if (!isStoredEnvelope(parsed)) {
      return { status: 'corrupt', value: defaultValue(), raw };
    }

    const { version: storedVersion, data } = parsed;

    if (storedVersion === version) {
      if (validate && !validate(data)) {
        return { status: 'corrupt', value: defaultValue(), raw };
      }
      return { status: 'ok', value: data as T };
    }

    if (storedVersion < version) {
      const migrated = migrate ? migrate(storedVersion, data) : undefined;
      if (migrated === undefined) {
        return { status: 'version-mismatch', value: defaultValue() };
      }
      if (validate && !validate(migrated)) {
        return { status: 'corrupt', value: defaultValue(), raw };
      }
      return { status: 'ok', value: migrated };
    }

    // storedVersion > version: downgrade, treat as unusable.
    return { status: 'version-mismatch', value: defaultValue() };
  }

  function read(): T {
    return readDetailed().value;
  }

  function write(data: T): void {
    const envelope: StoredEnvelope = { version, data };
    storage.setItem(key, JSON.stringify(envelope));
  }

  function remove(): void {
    storage.removeItem(key);
  }

  return { read, readDetailed, write, remove, key };
}
