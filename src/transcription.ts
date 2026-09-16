import fs from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptWord } from './smartCut';

// Stage 2 of the Level-3 pipeline. CLAUDE.md fixes transcription as "Whisper
// API" (not a locally hosted model), which is the reason this whole pipeline
// stays in Node: there is no heavy local computation here, only an HTTP call.

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

// The API rejects anything larger outright. Our extracted audio is mono
// 16kHz MP3 at roughly 0.5 MB/min, so this is ~50 minutes of speech — well
// past any reel — but a caller that hands us a podcast should get a clear
// reason rather than a 413 from a third party.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscriptionResult {
  words: TranscriptWord[];
  language: string | null;
  text: string;
}

// The pipeline takes this as an injected function so tests can run the whole
// staged flow without a network call or an API key — the same shape the rest
// of the codebase uses for its mocked externals.
export type Transcriber = (audioPath: string) => Promise<TranscriptionResult>;

export class TranscriptionError extends Error {
  constructor(readonly code: 'transcription_not_configured' | 'audio_too_large' | 'transcription_failed', detail?: string) {
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
  });

  if (!response.ok) {
    throw new TranscriptionError('transcription_failed', `${response.status} ${(await response.text()).slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    text?: string;
    language?: string;
    words?: Array<{ word?: string; start?: number; end?: number }>;
  };

  return {
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
}
