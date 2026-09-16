import { describe, expect, it } from 'vitest';
import {
  buildRequestBody,
  chunkPlan,
  dominantLanguage,
  MAX_CHUNK_SEC,
  parseDuration,
  recognizeChunk,
  wordsFromResponse,
  type GoogleSpeechConfig,
} from '../src/googleSpeech';

const CONFIG: GoogleSpeechConfig = {
  apiKey: 'test-key',
  languageCode: 'kk-KZ',
  alternativeLanguageCodes: ['ru-RU'],
};

describe('chunkPlan', () => {
  it('leaves a short clip as a single request', () => {
    expect(chunkPlan(29)).toEqual([{ startSec: 0, durationSec: 29 }]);
  });

  it('covers the whole file, including the remainder', () => {
    const plan = chunkPlan(130);
    const covered = plan.reduce((sum, c) => sum + c.durationSec, 0);
    // A short final chunk that got dropped would cut the captions off before
    // the speaker stops — invisible until someone watches the end.
    expect(covered).toBeCloseTo(130, 5);
    expect(plan[plan.length - 1].startSec + plan[plan.length - 1].durationSec).toBeCloseTo(130, 5);
  });

  it('never exceeds the synchronous-recognition limit', () => {
    for (const chunk of chunkPlan(600)) {
      expect(chunk.durationSec).toBeLessThanOrEqual(MAX_CHUNK_SEC);
    }
  });

  it('treats an unusable duration as nothing to transcribe', () => {
    expect(chunkPlan(0)).toEqual([]);
    expect(chunkPlan(Number.NaN)).toEqual([]);
  });
});

describe('parseDuration', () => {
  it('reads protobuf duration strings', () => {
    expect(parseDuration('1.500s')).toBe(1.5);
    expect(parseDuration('12s')).toBe(12);
    expect(parseDuration('0s')).toBe(0);
  });

  it('treats a missing or malformed value as the start of the clip', () => {
    expect(parseDuration(undefined)).toBe(0);
    expect(parseDuration('later')).toBe(0);
  });
});

describe('wordsFromResponse', () => {
  const payload = {
    results: [
      {
        languageCode: 'kk-kz',
        alternatives: [
          {
            transcript: 'он мың қадам',
            words: [
              { word: 'он', startTime: '0s', endTime: '0.400s' },
              { word: 'мың', startTime: '0.400s', endTime: '0.900s' },
              { word: 'қадам', startTime: '0.900s', endTime: '1.500s' },
            ],
          },
        ],
      },
    ],
  };

  it('flattens words with their timings', () => {
    expect(wordsFromResponse(payload)).toEqual([
      { word: 'он', start: 0, end: 0.4 },
      { word: 'мың', start: 0.4, end: 0.9 },
      { word: 'қадам', start: 0.9, end: 1.5 },
    ]);
  });

  it('shifts a chunk onto the original timeline', () => {
    // Chunk two of a long clip starts 55s in; without the offset every
    // chunk's captions would pile onto the first minute of the video.
    const shifted = wordsFromResponse(payload, 55);
    expect(shifted[0].start).toBe(55);
    expect(shifted[2].end).toBe(56.5);
  });

  it('ignores alternatives beyond the first, which are rival readings', () => {
    const withRivals = {
      results: [
        {
          alternatives: [
            { words: [{ word: 'бір', startTime: '0s', endTime: '1s' }] },
            { words: [{ word: 'бер', startTime: '0s', endTime: '1s' }] },
          ],
        },
      ],
    };
    // Taking both would duplicate the same second of speech.
    expect(wordsFromResponse(withRivals)).toHaveLength(1);
  });

  it('survives a result carrying no words at all', () => {
    expect(wordsFromResponse({ results: [{ alternatives: [{ transcript: '' }] }] })).toEqual([]);
    expect(wordsFromResponse({})).toEqual([]);
  });
});

describe('dominantLanguage', () => {
  it('reports the language covering the most utterances', () => {
    // Code-switching: Kazakh with Russian inserts — there is no single
    // answer, so the majority is what the job reports.
    const payload = {
      results: [
        { languageCode: 'kk-kz', alternatives: [{}] },
        { languageCode: 'ru-ru', alternatives: [{}] },
        { languageCode: 'kk-kz', alternatives: [{}] },
      ],
    };
    expect(dominantLanguage(payload)).toBe('kk-kz');
  });

  it('is null when the response says nothing about language', () => {
    expect(dominantLanguage({ results: [{ alternatives: [{}] }] })).toBeNull();
  });
});

describe('buildRequestBody', () => {
  it('asks for the two things Smart Cut cannot work without', () => {
    const body = buildRequestBody(CONFIG, 'YXVkaW8=', 16000);
    // Per-word timings drive the cut; alternative languages are why this
    // provider was chosen over the single-language engines.
    expect(body.config.enableWordTimeOffsets).toBe(true);
    expect(body.config.alternativeLanguageCodes).toEqual(['ru-RU']);
    expect(body.config.languageCode).toBe('kk-KZ');
    expect(body.config.sampleRateHertz).toBe(16000);
    expect(body.config.encoding).toBe('FLAC');
  });
});

describe('recognizeChunk', () => {
  it('sends the key as a query parameter, never as a header or body field', async () => {
    let seenUrl = '';
    const fakeFetch = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await recognizeChunk(CONFIG, 'YXVkaW8=', 16000, 0, fakeFetch);
    expect(seenUrl).toContain('key=test-key');
  });

  it('reports the API error instead of returning an empty transcript', async () => {
    const fakeFetch = (async () =>
      new Response('{"error":{"message":"API key not valid"}}', { status: 400 })) as unknown as typeof fetch;

    // A silent empty result here would render a video with no captions and
    // call it a success.
    await expect(recognizeChunk(CONFIG, 'YXVkaW8=', 16000, 0, fakeFetch)).rejects.toThrow(/400/);
  });
});
