import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashAudioFile, readCachedTranscript, writeCachedTranscript } from '../src/transcriptCache';
import { createTestDb, dropTestDb } from './dbTestHelper';
import type { Db } from '../src/db';

describe('hashAudioFile', () => {
  it('gives the same hash for the same bytes and a different one otherwise', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-'));
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    const c = path.join(dir, 'c.bin');
    await fs.writeFile(a, 'same audio');
    await fs.writeFile(b, 'same audio');
    await fs.writeFile(c, 'other audio');

    // The key is the content — two tenants uploading the same clip share the
    // transcript, and a re-render of one file finds its own.
    expect(await hashAudioFile(a)).toBe(await hashAudioFile(b));
    expect(await hashAudioFile(a)).not.toBe(await hashAudioFile(c));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('transcript cache', () => {
  let db: Db;
  const hash = 'a'.repeat(64);
  const stored = {
    words: [{ word: 'привет', start: 0, end: 0.5 }],
    text: 'привет',
    language: 'russian',
  };

  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { await dropTestDb(db); });

  it('returns null for audio never seen', async () => {
    expect(await readCachedTranscript(db, hash)).toBeNull();
  });

  it('gives back exactly what was stored', async () => {
    await writeCachedTranscript(db, hash, stored);
    expect(await readCachedTranscript(db, hash)).toEqual(stored);
  });

  it('keeps the first reading when two workers race', async () => {
    await writeCachedTranscript(db, hash, stored);
    await writeCachedTranscript(db, hash, { ...stored, text: 'другое', words: [] });

    // Both readings are valid, but overwriting would break the promise the
    // table exists for: the same file keeps giving the same words.
    expect((await readCachedTranscript(db, hash))?.text).toBe('привет');
  });
});
