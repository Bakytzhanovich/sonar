import { describe, expect, it } from 'vitest';
import { alignTextToWordTimings, needsTextCorrection, splitIntoWords } from '../src/transcriptAlign';
import type { TranscriptWord } from '../src/smartCut';

// Builds evenly spaced timed words, one per second.
function slots(words: string[]): TranscriptWord[] {
  return words.map((word, i) => ({ word, start: i, end: i + 0.8 }));
}

describe('alignTextToWordTimings', () => {
  it('replaces words one-for-one when both models agree on the count', () => {
    const timed = slots(['ол', 'мұшақ', 'жүргерек']);
    const out = alignTextToWordTimings(timed, 'ол мұқият керек');

    expect(out.map((w) => w.word)).toEqual(['ол', 'мұқият', 'керек']);
    // Timings must be untouched — this is the whole point of the hybrid.
    expect(out.map((w) => [w.start, w.end])).toEqual(timed.map((w) => [w.start, w.end]));
  });

  it('keeps the corrected text when the accurate model merges words', () => {
    // whisper split "жүру керек" into four fragments; gpt-4o heard two words.
    const timed = slots(['жүр', 'ге', 'ре', 'к']);
    const out = alignTextToWordTimings(timed, 'жүру керек');

    expect(out.map((w) => w.word)).toEqual(['жүру', 'керек']);
    expect(out[0].start).toBe(0);
    // The last word must still reach the end of the speech, or the caption
    // would vanish before the speaker stops talking.
    expect(out[out.length - 1].end).toBe(timed[timed.length - 1].end);
  });

  it('gives each word its own span when several share one slot', () => {
    const timed = slots(['бәрі']);
    const out = alignTextToWordTimings(timed, 'соның бәрін жасау');

    expect(out.map((w) => w.word)).toEqual(['соның', 'бәрін', 'жасау']);
    // Identical timings would make the renderer highlight all three at once.
    expect(out[0].end).toBeLessThanOrEqual(out[1].start);
    expect(out[1].end).toBeLessThanOrEqual(out[2].start);
    expect(out[0].start).toBe(0);
    expect(out[2].end).toBeCloseTo(0.8, 5);
  });

  it('never moves time backwards, whatever the word counts', () => {
    const timed = slots(Array.from({ length: 17 }, (_, i) => `w${i}`));
    const out = alignTextToWordTimings(timed, Array.from({ length: 23 }, (_, i) => `x${i}`).join(' '));

    expect(out).toHaveLength(23);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start);
      expect(out[i].end).toBeGreaterThanOrEqual(out[i].start);
    }
    expect(out[0].start).toBe(timed[0].start);
    expect(out[out.length - 1].end).toBe(timed[timed.length - 1].end);
  });

  it('stays inside the source timeline, so remapping after a cut still works', () => {
    const timed = slots(['a', 'b', 'c', 'd', 'e']);
    const out = alignTextToWordTimings(timed, 'one two three four five six seven');

    const firstStart = timed[0].start;
    const lastEnd = timed[timed.length - 1].end;
    for (const w of out) {
      expect(w.start).toBeGreaterThanOrEqual(firstStart);
      expect(w.end).toBeLessThanOrEqual(lastEnd);
    }
  });

  it('passes the timings through untouched when the correction is empty', () => {
    const timed = slots(['бір', 'екі']);
    expect(alignTextToWordTimings(timed, '   ')).toEqual(timed);
    expect(alignTextToWordTimings([], 'сөз')).toEqual([]);
  });
});

describe('needsTextCorrection', () => {
  it('asks for a second pass on languages whisper-1 mangles', () => {
    // verbose_json spells it out; an explicit language= request echoes the code.
    expect(needsTextCorrection('kazakh')).toBe(true);
    expect(needsTextCorrection('kk')).toBe(true);
    expect(needsTextCorrection('Kazakh')).toBe(true);
  });

  it('leaves languages whisper-1 handles well alone, to avoid a second bill', () => {
    expect(needsTextCorrection('russian')).toBe(false);
    expect(needsTextCorrection('english')).toBe(false);
    expect(needsTextCorrection(null)).toBe(false);
  });
});

describe('splitIntoWords', () => {
  it('keeps punctuation attached and drops the gaps', () => {
    expect(splitIntoWords('  Айту  қиын,\nістеу қиын. ')).toEqual(['Айту', 'қиын,', 'істеу', 'қиын.']);
  });
});
