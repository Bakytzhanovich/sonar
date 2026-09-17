import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { exec, queryOne, type Db } from './db';
import type { TranscriptionResult } from './transcription';

// Making captions repeatable.
//
// Speech recognition is not deterministic. The audio model returns a
// slightly different reading of the same file on each pass — which is what
// the ensemble relies on, but it also meant that re-rendering a clip
// produced different captions than the first time, with no way to get the
// earlier ones back. For a feature whose output is burned into a client's
// video, "run it again and see" is not an acceptable answer.
//
// Keyed by the audio rather than the job: the same recording gives the same
// words whatever job asked, which also means an edit re-run after a caption
// correction does not pay for recognition a second time.

export interface CachedTranscript {
  words: TranscriptionResult['words'];
  text: string;
  language: string | null;
}

/**
 * SHA-256 of the file, streamed.
 *
 * Streamed rather than read whole: this runs on extracted audio, which is
 * small, but the worker is memory-constrained and there is no reason to hold
 * a file in memory to hash it.
 */
export function hashAudioFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function readCachedTranscript(db: Db, audioHash: string): Promise<CachedTranscript | null> {
  const row = await queryOne<{ words: CachedTranscript['words']; text: string; language: string | null }>(
    db,
    `SELECT words, text, language FROM transcript_cache WHERE audio_hash = ?`,
    audioHash
  );
  return row ? { words: row.words, text: row.text, language: row.language } : null;
}

export async function writeCachedTranscript(db: Db, audioHash: string, result: CachedTranscript): Promise<void> {
  // ON CONFLICT DO NOTHING rather than an upsert: two workers transcribing
  // the same audio at once produce equally valid readings, and overwriting
  // the stored one would break the promise this table exists to make — that
  // the same file keeps giving the same words.
  await exec(
    db,
    `INSERT INTO transcript_cache (audio_hash, words, text, language)
     VALUES (?, ?::jsonb, ?, ?)
     ON CONFLICT (audio_hash) DO NOTHING`,
    audioHash,
    JSON.stringify(result.words),
    result.text,
    result.language
  );
}
