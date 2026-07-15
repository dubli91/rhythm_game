import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from './local';
import { STORAGE_KEYS, createLocalDoc } from './local';

/** Small in-memory fake implementing KeyValueStorage, standing in for window.localStorage. */
function createFakeStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
}

interface Nested {
  nested: { a: number; list: string[] };
}

function isNested(data: unknown): data is Nested {
  if (typeof data !== 'object' || data === null || !('nested' in data)) {
    return false;
  }
  const nested = (data as Record<string, unknown>).nested;
  return typeof nested === 'object' && nested !== null && 'a' in nested && 'list' in nested;
}

describe('createLocalDoc', () => {
  it('returns the default and status "missing" when nothing is stored', () => {
    const storage = createFakeStorage();
    const doc = createLocalDoc<{ n: number }>({
      storage,
      key: 'test.v1',
      version: 1,
      defaultValue: () => ({ n: 42 }),
    });

    expect(doc.read()).toEqual({ n: 42 });
    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('missing');
    expect(detailed.value).toEqual({ n: 42 });
  });

  it('round-trips a nested object through write/read and serializes {version, data}', () => {
    const storage = createFakeStorage();
    const doc = createLocalDoc<Nested>({
      storage,
      key: 'nested.v1',
      version: 1,
      defaultValue: () => ({ nested: { a: 0, list: [] } }),
    });

    const value: Nested = { nested: { a: 7, list: ['x', 'y'] } };
    doc.write(value);

    expect(doc.read()).toEqual(value);
    expect(storage.getItem('nested.v1')).toBe(JSON.stringify({ version: 1, data: value }));
  });

  it('treats corrupt JSON as corrupt, preserves raw, and never throws from read()', () => {
    const storage = createFakeStorage();
    storage.setItem('corrupt.v1', '{oops');
    const doc = createLocalDoc<{ n: number }>({
      storage,
      key: 'corrupt.v1',
      version: 1,
      defaultValue: () => ({ n: 1 }),
    });

    expect(() => doc.read()).not.toThrow();
    expect(doc.read()).toEqual({ n: 1 });

    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('corrupt');
    expect(detailed.value).toEqual({ n: 1 });
    expect(detailed.raw).toBe('{oops');
  });

  it('treats data failing validate() as corrupt', () => {
    const storage = createFakeStorage();
    storage.setItem('shape.v1', JSON.stringify({ version: 1, data: { wrong: true } }));
    const doc = createLocalDoc<Nested>({
      storage,
      key: 'shape.v1',
      version: 1,
      defaultValue: () => ({ nested: { a: 0, list: [] } }),
      validate: isNested,
    });

    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('corrupt');
    expect(detailed.value).toEqual({ nested: { a: 0, list: [] } });
    expect(detailed.raw).toBe(JSON.stringify({ version: 1, data: { wrong: true } }));
  });

  it('migrates an older version via the migrate hook and reports "ok"', () => {
    const storage = createFakeStorage();
    storage.setItem('migrate.v2', JSON.stringify({ version: 1, data: { old: 'value' } }));
    const doc = createLocalDoc<{ upgraded: string }>({
      storage,
      key: 'migrate.v2',
      version: 2,
      defaultValue: () => ({ upgraded: 'default' }),
      migrate: (storedVersion, data) => {
        if (storedVersion === 1) {
          const old = (data as { old: string }).old;
          return { upgraded: old };
        }
        return undefined;
      },
    });

    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('ok');
    expect(detailed.value).toEqual({ upgraded: 'value' });
    expect(doc.read()).toEqual({ upgraded: 'value' });
    // migrate does not auto-rewrite storage; the raw stored envelope is untouched.
    expect(storage.getItem('migrate.v2')).toBe(
      JSON.stringify({ version: 1, data: { old: 'value' } }),
    );
  });

  it('reports "version-mismatch" + default for an older version with no migrate hook', () => {
    const storage = createFakeStorage();
    storage.setItem('nomigrate.v2', JSON.stringify({ version: 1, data: { old: 'value' } }));
    const doc = createLocalDoc<{ upgraded: string }>({
      storage,
      key: 'nomigrate.v2',
      version: 2,
      defaultValue: () => ({ upgraded: 'default' }),
    });

    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('version-mismatch');
    expect(detailed.value).toEqual({ upgraded: 'default' });
  });

  it('reports "version-mismatch" + default when migrate returns undefined (unmigratable)', () => {
    const storage = createFakeStorage();
    storage.setItem('unmigratable.v2', JSON.stringify({ version: 1, data: { old: 'value' } }));
    const doc = createLocalDoc<{ upgraded: string }>({
      storage,
      key: 'unmigratable.v2',
      version: 2,
      defaultValue: () => ({ upgraded: 'default' }),
      migrate: () => undefined,
    });

    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('version-mismatch');
    expect(detailed.value).toEqual({ upgraded: 'default' });
  });

  it('reports "version-mismatch" + default when the stored version is newer than current', () => {
    const storage = createFakeStorage();
    storage.setItem('newer.v1', JSON.stringify({ version: 99, data: { n: 1 } }));
    const doc = createLocalDoc<{ n: number }>({
      storage,
      key: 'newer.v1',
      version: 1,
      defaultValue: () => ({ n: 0 }),
    });

    const detailed = doc.readDetailed();
    expect(detailed.status).toBe('version-mismatch');
    expect(detailed.value).toEqual({ n: 0 });
  });

  it('propagates exceptions thrown by storage.setItem from write()', () => {
    const storage = createFakeStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const doc = createLocalDoc<{ n: number }>({
      storage,
      key: 'quota.v1',
      version: 1,
      defaultValue: () => ({ n: 0 }),
    });

    expect(() => doc.write({ n: 5 })).toThrow('QuotaExceededError');
  });

  it('calls defaultValue() fresh each time so mutating one read() result does not affect the next', () => {
    const storage = createFakeStorage();
    const doc = createLocalDoc<{ list: number[] }>({
      storage,
      key: 'fresh.v1',
      version: 1,
      defaultValue: () => ({ list: [] }),
    });

    const first = doc.read();
    first.list.push(1);

    const second = doc.read();
    expect(second.list).toEqual([]);
  });

  it('removes stored data via remove()', () => {
    const storage = createFakeStorage();
    const doc = createLocalDoc<{ n: number }>({
      storage,
      key: 'remove.v1',
      version: 1,
      defaultValue: () => ({ n: 0 }),
    });
    doc.write({ n: 1 });
    expect(storage.getItem('remove.v1')).not.toBeNull();

    doc.remove();
    expect(storage.getItem('remove.v1')).toBeNull();
    expect(doc.readDetailed().status).toBe('missing');
  });

  it('exposes the exact standardized storage keys', () => {
    expect(STORAGE_KEYS.settings).toBe('settings.v1');
    expect(STORAGE_KEYS.playOptions).toBe('playOptions.v1');
    expect(STORAGE_KEYS.records).toBe('records.v1');
  });
});
