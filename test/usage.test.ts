import { describe, it, expect } from 'vitest';
import { summarizeUsage, usageFromResponse, usageFromSeconds } from '../src/usage';

describe('usageFromResponse', () => {
  it('reads the block OpenAI already sends on every call', () => {
    // This is the whole point: the numbers were arriving and being discarded,
    // so "what does a video cost" had no answer but arithmetic on a price
    // list — a guess about our own system.
    const entry = usageFromResponse('gpt-audio', {
      choices: [],
      usage: { prompt_tokens: 12_400, completion_tokens: 310, prompt_tokens_details: { audio_tokens: 12_000, text_tokens: 400 } },
    });

    expect(entry).toEqual({
      model: 'gpt-audio',
      calls: 1,
      inputTokens: 12_400,
      outputTokens: 310,
      audioTokens: 12_000,
    });
  });

  it('separates the audio part, which is where the bill actually goes', () => {
    const entry = usageFromResponse('gpt-audio', {
      usage: { prompt_tokens: 12_400, prompt_tokens_details: { audio_tokens: 12_000 } },
    });
    // 97% of the input is the recording, not the prompt. Folding them
    // together would hide that three passes of a ten-minute clip is the cost.
    expect(entry.audioTokens! / entry.inputTokens!).toBeGreaterThan(0.9);
  });

  it('records a call with no usage block as zeroes, not as nothing', () => {
    // A call that happened was billed. Counting it as one call with unknown
    // tokens keeps the count honest and makes the gap visible.
    const entry = usageFromResponse('gpt-4.1', { choices: [] });
    expect(entry.calls).toBe(1);
    expect(entry.inputTokens).toBe(0);
  });

  it.each([[null], [undefined], ['not json'], [42]])('survives a body shaped like %s', (body) => {
    expect(usageFromResponse('gpt-4.1', body).calls).toBe(1);
  });
});

describe('usageFromSeconds', () => {
  it('measures the transcription endpoint in its own unit', () => {
    // It bills by length of audio and reports no tokens at all, so adding it
    // to a token count would produce a number that means nothing.
    const entry = usageFromSeconds('whisper-1', 612.345);
    expect(entry).toEqual({ model: 'whisper-1', calls: 1, audioSeconds: 612.35 });
    expect(entry.inputTokens).toBeUndefined();
  });
});

describe('summarizeUsage', () => {
  it('collapses repeated passes into one line with a count', () => {
    // Three passes of the same model is one row saying "3", not three rows:
    // the question is what a video costs.
    const summary = summarizeUsage([
      usageFromResponse('gpt-audio', { usage: { prompt_tokens: 12_000, completion_tokens: 300, prompt_tokens_details: { audio_tokens: 11_800 } } }),
      usageFromResponse('gpt-audio', { usage: { prompt_tokens: 12_000, completion_tokens: 290, prompt_tokens_details: { audio_tokens: 11_800 } } }),
      usageFromResponse('gpt-audio', { usage: { prompt_tokens: 12_000, completion_tokens: 305, prompt_tokens_details: { audio_tokens: 11_800 } } }),
    ]);

    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({ model: 'gpt-audio', calls: 3, inputTokens: 36_000, audioTokens: 35_400 });
  });

  it('keeps the two billing units apart', () => {
    const summary = summarizeUsage([
      usageFromSeconds('whisper-1', 600),
      usageFromResponse('gpt-4.1', { usage: { prompt_tokens: 4_000, completion_tokens: 900 } }),
    ]);

    const whisper = summary.entries.find((e) => e.model === 'whisper-1')!;
    const repair = summary.entries.find((e) => e.model === 'gpt-4.1')!;
    expect(whisper.audioSeconds).toBe(600);
    expect(whisper.inputTokens).toBeUndefined();
    expect(repair.inputTokens).toBe(4_000);
    expect(repair.audioSeconds).toBeUndefined();
  });

  it('puts the expensive line first', () => {
    // Whoever opens this wants to know what the bill was, and the line that
    // explains it should be the one read first.
    const summary = summarizeUsage([
      usageFromResponse('gpt-4.1', { usage: { prompt_tokens: 4_000 } }),
      usageFromResponse('gpt-audio', { usage: { prompt_tokens: 36_000, prompt_tokens_details: { audio_tokens: 35_400 } } }),
    ]);
    expect(summary.entries[0].model).toBe('gpt-audio');
  });

  it('returns nothing for a job that spent nothing', () => {
    // A cache hit. Recording no entries is correct; recording zeroes would
    // read as "measured and free".
    expect(summarizeUsage([]).entries).toEqual([]);
  });
});
