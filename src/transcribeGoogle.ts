import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudioChunk, probe } from './ffmpeg';
import {
  chunkPlan,
  mergeOverlappingWords,
  googleSpeechConfigFromEnv,
  recognizeChunk,
  type GoogleSpeechConfig,
} from './googleSpeech';
import { TranscriptionError, type TranscriptionResult } from './transcription';

// 16 kHz mono is what every speech recogniser downsamples to internally;
// sending more is bandwidth spent on information the model discards.
const SAMPLE_RATE_HZ = 16000;

/**
 * Transcribes with Google Speech-to-Text, chunking the audio so a clip longer
 * than the synchronous limit works without a GCS bucket.
 *
 * Chunks are recognised in order, one at a time. Sequential rather than
 * parallel on purpose: the render worker already runs one job per process to
 * keep a core free for ffmpeg, so firing several HTTP requests at once would
 * only trade a little wall-clock for a quota spike and out-of-order failures
 * that are harder to attribute.
 */
export async function transcribeWithGoogle(
  audioPath: string,
  config: GoogleSpeechConfig
): Promise<TranscriptionResult> {
  const { durationSec } = await probe(audioPath);
  const chunks = chunkPlan(durationSec);
  if (chunks.length === 0) return { words: [], language: null, text: '' };

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-gspeech-'));
  try {
    const words: TranscriptionResult['words'] = [];
    const languages: string[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = path.join(workDir, `chunk-${index}.flac`);
      await extractAudioChunk(audioPath, chunkPath, chunk.startSec, chunk.durationSec, SAMPLE_RATE_HZ);
      const audioBase64 = (await fs.readFile(chunkPath)).toString('base64');

      const result = await recognizeChunk(config, audioBase64, SAMPLE_RATE_HZ, chunk.startSec);
      words.push(...mergeOverlappingWords(words, result.words));
      if (result.language) languages.push(result.language);
    }

    return {
      words,
      // With code-switching there is no one language; report the first one
      // Google settled on, which is what the UI shows as "recognised as".
      language: languages[0] ?? null,
      text: words.map((w) => w.word).join(' '),
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// Picks the transcriber for this deployment. Google when a key is present,
// Whisper otherwise — so nothing breaks for an install that has not set one
// up, and Russian/English keep working exactly as before.
export function transcriberFromEnv(whisperFallback: (audioPath: string) => Promise<TranscriptionResult>) {
  const google = googleSpeechConfigFromEnv();
  if (!google) return whisperFallback;

  return async (audioPath: string): Promise<TranscriptionResult> => {
    try {
      const result = await transcribeWithGoogle(audioPath, google);
      // An empty result from Google (bad key, unsupported sample rate, silence
      // it did not recognise) should not leave the job with no captions when
      // Whisper could still produce something.
      if (result.words.length > 0) return result;
      return await whisperFallback(audioPath);
    } catch (err) {
      // Falling back rather than failing: a render that ships with
      // less-accurate captions beats a job that dies because one provider had
      // an outage. The reason is logged so this never fails silently.
      console.warn(`[transcribe] google failed, falling back to whisper: ${err instanceof Error ? err.message : String(err)}`);
      try {
        return await whisperFallback(audioPath);
      } catch (fallbackErr) {
        throw fallbackErr instanceof TranscriptionError
          ? fallbackErr
          : new TranscriptionError('transcription_failed', String(fallbackErr));
      }
    }
  };
}
