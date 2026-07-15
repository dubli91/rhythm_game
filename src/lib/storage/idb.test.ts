import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { CHART_FORMAT_VERSION, type Song } from '../chart/types';
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  deleteSong,
  idbDelete,
  idbGet,
  idbGetAll,
  idbGetAllKeys,
  idbPut,
  openDatabase,
  putSongAtomic,
} from './idb';

function makeSong(songId: string): Song {
  return {
    songId,
    title: `Song ${songId}`,
    artist: 'Test Artist',
    genre: 'Test Genre',
    audio: { source: 'imported', ref: songId, offsetMs: 0 },
    charts: [
      {
        formatVersion: CHART_FORMAT_VERSION,
        chartId: `${songId}-another`,
        difficulty: 'ANOTHER',
        level: 8,
        total: 250,
        bpm: { init: 150, min: 150, max: 150 },
        timing: { bpmEvents: [{ beat: 0, bpm: 150 }], stopEvents: [] },
        notes: [{ beat: 0, lane: 1, type: 'tap' }],
      },
    ],
  };
}

function makeAudioBlob(content = 'RIFF....WAVEfmt '): Blob {
  return new Blob([content], { type: 'audio/wav' });
}

describe('idb', () => {
  let factory: IDBFactory;

  beforeEach(() => {
    // Fresh factory per test: fake-indexeddb persists databases on the factory instance,
    // so isolation between tests requires a new one rather than the shared global.
    factory = new IDBFactory();
  });

  it('openDatabase creates all three object stores', async () => {
    const db = await openDatabase(factory);

    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(
      [STORES.songs, STORES.audio, STORES.practicePatterns].sort(),
    );

    db.close();
  });

  it('opening the same factory a second time succeeds with no upgrade needed', async () => {
    const first = await openDatabase(factory);
    first.close();

    const second = await openDatabase(factory);
    expect(Array.from(second.objectStoreNames).sort()).toEqual(
      [STORES.songs, STORES.audio, STORES.practicePatterns].sort(),
    );

    second.close();
  });

  it('putSongAtomic round-trips song metadata and its audio blob, keyed by songId', async () => {
    const db = await openDatabase(factory);
    const song = makeSong('song-1');
    const blob = makeAudioBlob();

    await putSongAtomic(db, song, blob);

    const storedSong = await idbGet<Song>(db, STORES.songs, 'song-1');
    const storedAudio = await idbGet<Blob>(db, STORES.audio, 'song-1');

    expect(storedSong).toEqual(song);
    expect(storedAudio).toBeInstanceOf(Blob);
    expect(storedAudio?.size).toBe(blob.size);
    expect(await storedAudio?.text()).toBe(await blob.text());

    db.close();
  });

  it('putSongAtomic with a null audioBlob stores metadata only', async () => {
    const db = await openDatabase(factory);
    const song = makeSong('song-2');

    await putSongAtomic(db, song, null);

    const storedSong = await idbGet<Song>(db, STORES.songs, 'song-2');
    const storedAudio = await idbGet<Blob>(db, STORES.audio, 'song-2');

    expect(storedSong).toEqual(song);
    expect(storedAudio).toBeUndefined();

    db.close();
  });

  it('deleteSong removes both the song metadata and its audio blob', async () => {
    const db = await openDatabase(factory);
    const song = makeSong('song-4');
    await putSongAtomic(db, song, makeAudioBlob());

    await deleteSong(db, 'song-4');

    expect(await idbGet(db, STORES.songs, 'song-4')).toBeUndefined();
    expect(await idbGet(db, STORES.audio, 'song-4')).toBeUndefined();

    db.close();
  });

  it('idbGetAll and idbGetAllKeys return every stored song', async () => {
    const db = await openDatabase(factory);
    const songA = makeSong('song-a');
    const songB = makeSong('song-b');
    await putSongAtomic(db, songA, makeAudioBlob('a'));
    await putSongAtomic(db, songB, makeAudioBlob('b'));

    const all = await idbGetAll<Song>(db, STORES.songs);
    const keys = await idbGetAllKeys(db, STORES.songs);

    expect(all.map((song) => song.songId).sort()).toEqual(['song-a', 'song-b']);
    expect([...keys].sort()).toEqual(['song-a', 'song-b']);

    db.close();
  });

  it('idbGet resolves undefined for a missing key', async () => {
    const db = await openDatabase(factory);

    expect(await idbGet(db, STORES.songs, 'does-not-exist')).toBeUndefined();

    db.close();
  });

  it('idbPut with an explicit out-of-line key round-trips, then idbDelete removes it', async () => {
    const db = await openDatabase(factory);
    const blob = makeAudioBlob('standalone');

    await idbPut(db, STORES.audio, blob, 'standalone-key');
    const stored = await idbGet<Blob>(db, STORES.audio, 'standalone-key');
    expect(stored).toBeInstanceOf(Blob);

    await idbDelete(db, STORES.audio, 'standalone-key');
    expect(await idbGet(db, STORES.audio, 'standalone-key')).toBeUndefined();

    db.close();
  });

  it('putSongAtomic is all-or-nothing: a mid-transaction failure leaves no audio or song row', async () => {
    const db = await openDatabase(factory);
    const song = makeSong('song-3');
    const blob = makeAudioBlob();

    // Drop the keyPath field so the write inside the transaction throws synchronously
    // (songs' keyPath is 'songId'; the audio store's out-of-line key is also derived from
    // song.songId, so either write failing synchronously exercises the same abort path).
    const { songId: _dropped, ...brokenSong } = song;

    await expect(putSongAtomic(db, brokenSong as unknown as Song, blob)).rejects.toThrow();

    const storedSong = await idbGet<Song>(db, STORES.songs, 'song-3');
    const storedAudio = await idbGet<Blob>(db, STORES.audio, 'song-3');

    expect(storedSong).toBeUndefined();
    expect(storedAudio).toBeUndefined();

    db.close();
  });
});
