import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptWord } from './smartCut';
import { alignTextToWordTimings, needsTextCorrection } from './transcriptAlign';
import { AUDIO_PASSES, reconstructTranscript, transcribeWithAudioModel } from './transcriptEnsemble';

// Stage 2 of the Level-3 pipeline. CLAUDE.md fixes transcription as "Whisper
// API" (not a locally hosted model), which is the reason this whole pipeline
// stays in Node: there is no heavy local computation here, only an HTTP call.

import { usageFromSeconds, type UsageEntry } from './usage';

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

// The endpoint bills by length of audio and returns no usage block, so the
// duration has to come from what it transcribed. The last word's end time is
// a floor, not the file's true length — trailing silence is not in the
// transcript — but it is measured rather than assumed.
function durationOf(words: TranscriptWord[]): number {
  return words.length === 0 ? 0 : Math.max(...words.map((w) => w.end));
}
const MODEL = 'whisper-1';

// Only used for languages whisper-1 mangles (see transcriptAlign.ts). It is
// the better transcriber but returns no timestamps at all — verbose_json is
// rejected outright — so it can never replace whisper-1, only correct it.
// The /audio/transcriptions endpoints are no longer used for these
// languages: measured on a real Kazakh clip, every one of them (whisper-1,
// gpt-4o-transcribe, gpt-transcribe) produced phonetic nonsense and flattened
// Russian inserts, while the audio-input chat model got the sentence — and
// the mixed languages — right. whisper-1 stays only as the source of timings.

// The API rejects anything larger outright. Our extracted audio is mono
// 16kHz MP3 at roughly 0.5 MB/min, so this is ~50 minutes of speech — well
// past any reel — but a caller that hands us a podcast should get a clear
// reason rather than a 413 from a third party.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Generous: a 20-minute clip's audio takes a while to upload and transcribe.
// The point is a ceiling, not a tight bound.
const WHISPER_TIMEOUT_MS = 300_000;

export interface TranscriptionResult {
  words: TranscriptWord[];
  language: string | null;
  text: string;
  /**
   * What this transcription cost, one entry per model.
   *
   * Optional because an injected test transcriber has nothing to report, and
   * because a job recorded before this existed has none — absent means "not
   * measured", which is different from "free".
   */
  usage?: UsageEntry[];
}

// The pipeline takes this as an injected function so tests can run the whole
// staged flow without a network call or an API key — the same shape the rest
// of the codebase uses for its mocked externals.
export type Transcriber = (audioPath: string) => Promise<TranscriptionResult>;

export class TranscriptionError extends Error {
  constructor(
    readonly code:
      | 'transcription_not_configured'
      | 'transcription_quota_exhausted'
      | 'audio_too_large'
      | 'transcription_failed',
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TranscriptionError';
  }
}

export async function transcribeWithWhisper(audioPath: string): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TranscriptionError('transcription_not_configured');

  const stat = await fs.stat(audioPath);
  if (stat.size > MAX_AUDIO_BYTES) throw new TranscriptionError('audio_too_large', `${stat.size} bytes`);

  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(audioPath)], { type: 'audio/mpeg' }), path.basename(audioPath));
  form.append('model', MODEL);
  // verbose_json is the only response format that carries timestamps at all,
  // and the granularity parameter is what promotes them from per-segment to
  // per-word. Per-segment timestamps would make the whole smart cut useless:
  // a "segment" is a whole sentence, so pauses inside it stay invisible.
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  const response = await fetch(TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    // fetch has no default timeout. The worker processes one job at a time,
    // so a stalled connection here does not fail a request — it stops the
    // whole worker until someone notices.
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    // Out of credit is not a transient failure: retrying spends nothing but
    // time, and every job in the queue hits it in turn. Separated so the
    // pipeline stops rather than grinding, and so the user is told the real
    // reason instead of "transcription failed".
    if (response.status === 429 && /insufficient_quota|credit_balance|billing/i.test(body)) {
      throw new TranscriptionError('transcription_quota_exhausted', body);
    }
    throw new TranscriptionError('transcription_failed', `${response.status} ${body}`);
  }

  const payload = (await response.json()) as {
    text?: string;
    language?: string;
    words?: Array<{ word?: string; start?: number; end?: number }>;
  };

  const result: TranscriptionResult = {
    // A 200 with no words is a real outcome, not an error: silent video, or
    // audio the model found no speech in. planSmartCut handles an empty
    // transcript by keeping the source whole, so this is passed through
    // rather than thrown.
    words: (payload.words ?? [])
      .filter((w): w is { word: string; start: number; end: number } =>
        typeof w.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
      .map((w) => ({ word: w.word, start: w.start, end: w.end })),
    language: payload.language ?? null,
    text: payload.text ?? '',
  };

  // Billed by length of audio, not by token — the endpoint reports no usage
  // at all, so the duration is the only honest unit here.
  const whisperUsage = usageFromSeconds(MODEL, durationOf(result.words));
  if (!needsTextCorrection(result.language) || result.words.length === 0) {
    return { ...result, usage: [whisperUsage] };
  }

  // Extra passes, for these languages only. A failure here is not fatal: the
  // cut itself only needs the timings we already have, so we fall back to
  // whisper's own text rather than failing the whole job.
  try {
    // Several passes of the audio model on the same file. It is the only
    // OpenAI model that both reads Kazakh and keeps code-switching intact,
    // but it is not deterministic — and that is exactly what the repair step
    // needs: where the passes agree the word is certain, where they diverge
    // it is not.
    const audioBase64 = (await fs.readFile(audioPath)).toString('base64');
    const usage: UsageEntry[] = [whisperUsage];
    const others = await Promise.all(
      Array.from({ length: AUDIO_PASSES }, async (_unused, i) => {
        // A pass that throws still cost whatever it consumed before failing,
        // but the response never arrived to say how much — so it contributes
        // an empty transcript and no usage line, rather than a fabricated one.
        const pass = await transcribeWithAudioModel(audioBase64, 'mp3', apiKey).catch(() => null);
        if (pass) usage.push(pass.usage);
        return { engine: `audio-${i + 1}`, text: pass?.text ?? '' };
      })
    );

    const variants = [{ engine: MODEL, text: result.text }, ...others];
    const reconstruction = await reconstructTranscript(variants, apiKey);
    if (reconstruction.usage) usage.push(reconstruction.usage);
    const repaired = reconstruction.text;
    if (repaired) {
      return { ...result, usage, words: alignTextToWordTimings(result.words, repaired), text: repaired };
    }

    // No usable reconstruction — fall back to the single best-sounding
    // engine rather than to whisper's own output.
    const best = others.find((v) => v.text.trim().length > 0);
    if (!best) return { ...result, usage };
    return { ...result, usage, words: alignTextToWordTimings(result.words, best.text), text: best.text };
  } catch (err) {
    console.warn(`[transcribe] repair skipped: ${err instanceof Error ? err.message : String(err)}`);
    // The passes that did complete were billed, so what was measured is kept.
    return { ...result, usage: [whisperUsage] };
  }
}
