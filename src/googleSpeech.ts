import type { TranscriptWord } from './smartCut';

// Google Cloud Speech-to-Text, used instead of Whisper for languages Whisper
// cannot actually transcribe — Kazakh above all, which is this product's home
// market. See assets/../transcriptAlign.ts for the measurements that led here:
// whisper-1 returns phonetic nonsense on Kazakh and gpt-4o-transcribe returns
// no timestamps at all, so neither can drive Smart Cut.
//
// Two properties make this the right provider rather than Yandex/Azure:
//
//   1. alternativeLanguageCodes — the language is decided PER UTTERANCE, not
//      once per file. Kazakh speakers routinely switch to Russian mid-sentence
//      ("Прост жақты", "энергия"), and a single-language engine mangles
//      whichever half it did not pick.
//   2. enableWordTimeOffsets — per-word timings, which Smart Cut requires.
//
// Authentication is a plain API key in the query string: no service account,
// no OAuth dance, no JSON file to mount into the worker container.

const RECOGNIZE_URL = 'https://speech.googleapis.com/v1/speech:recognize';

// Synchronous recognition accepts at most ~60s of audio. Rather than take on
// a GCS bucket purely to use the long-running endpoint, the caller splits the
// audio and each chunk's timings are shifted back by its offset. 55s leaves
// room for the encoder's own rounding.
export const MAX_CHUNK_SEC = 55;

export interface GoogleSpeechConfig {
  apiKey: string;
  // Primary language, e.g. 'kk-KZ'.
  languageCode: string;
  // Up to 3 more the engine may switch to mid-file, e.g. ['ru-RU'].
  alternativeLanguageCodes: string[];
}

export function googleSpeechConfigFromEnv(): GoogleSpeechConfig | null {
  const apiKey = process.env.GOOGLE_SPEECH_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    languageCode: process.env.GOOGLE_SPEECH_LANGUAGE ?? 'kk-KZ',
    alternativeLanguageCodes: (process.env.GOOGLE_SPEECH_ALT_LANGUAGES ?? 'ru-RU')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean)
      .slice(0, 3),
  };
}

interface GoogleWord {
  word?: string;
  startTime?: string;
  endTime?: string;
}

interface GoogleResponse {
  results?: Array<{
    languageCode?: string;
    alternatives?: Array<{ transcript?: string; words?: GoogleWord[] }>;
  }>;
}

// Google encodes times as a protobuf Duration string: "1.500s", "12s", "0s".
export function parseDuration(value: string | undefined): number {
  if (!value) return 0;
  const seconds = Number(value.endsWith('s') ? value.slice(0, -1) : value);
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Flattens one recognize response into words, shifting every timing by
 * `offsetSec` so a chunk taken from the middle of a file reports positions on
 * the original timeline. Without the shift, every chunk would start at zero
 * and the captions of a long clip would all pile onto its first minute.
 */
export function wordsFromResponse(payload: GoogleResponse, offsetSec = 0): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const result of payload.results ?? []) {
    // Only the first alternative is requested (maxAlternatives defaults to 1);
    // any others would be competing transcripts of the same audio, not more of
    // it, and concatenating them would duplicate the speech.
    for (const word of result.alternatives?.[0]?.words ?? []) {
      if (!word.word) continue;
      words.push({
        word: word.word,
        start: parseDuration(word.startTime) + offsetSec,
        end: parseDuration(word.endTime) + offsetSec,
      });
    }
  }
  return words;
}

// The dominant language across the response, so the job can report what was
// actually heard rather than what was requested. With code-switching there is
// no single answer, so this reports the one covering the most utterances.
export function dominantLanguage(payload: GoogleResponse): string | null {
  const counts = new Map<string, number>();
  for (const result of payload.results ?? []) {
    const code = result.languageCode;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

export function buildRequestBody(config: GoogleSpeechConfig, audioBase64: string, sampleRateHz: number) {
  return {
    config: {
      // FLAC rather than MP3: lossless, so the encoder cannot smear the
      // consonants the model needs, and Google decodes it natively.
      encoding: 'FLAC',
      sampleRateHertz: sampleRateHz,
      languageCode: config.languageCode,
      alternativeLanguageCodes: config.alternativeLanguageCodes,
      // The whole reason this provider is here.
      enableWordTimeOffsets: true,
      // "latest_long" is tuned for speech longer than a command phrase, which
      // is what a reel is; the default model is optimised for short commands.
      model: 'latest_long',
      enableAutomaticPunctuation: true,
    },
    audio: { content: audioBase64 },
  };
}

export async function recognizeChunk(
  config: GoogleSpeechConfig,
  audioBase64: string,
  sampleRateHz: number,
  offsetSec: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ words: TranscriptWord[]; language: string | null }> {
  const response = await fetchImpl(`${RECOGNIZE_URL}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildRequestBody(config, audioBase64, sampleRateHz)),
    // Without a deadline a stalled connection would hold a render worker —
    // which processes one job at a time — open indefinitely.
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`google speech ${response.status}: ${detail}`);
  }

  const payload = (await response.json()) as GoogleResponse;
  return { words: wordsFromResponse(payload, offsetSec), language: dominantLanguage(payload) };
}

// Chunk boundaries for an audio file of `durationSec`, as [start, duration]
// pairs. Exported for its own test: an off-by-one here silently drops the
// last seconds of speech, which is invisible until someone watches the end of
// a rendered video and finds the captions stop early.
export function chunkPlan(durationSec: number, maxChunkSec = MAX_CHUNK_SEC): Array<{ startSec: number; durationSec: number }> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const chunks: Array<{ startSec: number; durationSec: number }> = [];
  for (let start = 0; start < durationSec; start += maxChunkSec) {
    chunks.push({ startSec: start, durationSec: Math.min(maxChunkSec, durationSec - start) });
  }
  return chunks;
}
