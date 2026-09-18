import { describe, expect, it } from 'vitest';
import { alignTextToWordTimings, needsTextCorrection, resemblance, splitIntoWords } from '../src/transcriptAlign';
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

describe('alignment by resemblance', () => {
  it('scores near-misses high and unrelated words low', () => {
    // The pair the whole approach rests on: whisper's Kazakh is phonetically
    // close to the truth, not random.
    // The numbers the threshold was set from, measured on real footage.
    expect(resemblance('жүргерек', 'жүру')).toBeGreaterThan(0.3);
    expect(resemblance('мұқият', 'мұшақ')).toBeGreaterThan(0.3);
    expect(resemblance('кереке', 'керек')).toBeGreaterThan(0.8);
    expect(resemblance('Просто,', 'просто')).toBe(1);

    // The worst false pair found scored 0.125, well under the 0.3 line.
    expect(resemblance('айту', 'болғанын')).toBeLessThan(0.3);
    expect(resemblance('энергия', 'мұшақ')).toBe(0);
  });

  it('pins a word to the slot that sounds like it, not to its position', () => {
    // Whisper heard five words; the repair says four. The last one is
    // unmistakably "керек" and belongs at 4.0s, where that slot sits — a
    // proportional split would have placed it at 3.0s instead.
    const timed = [
      { word: 'осы', start: 0, end: 1 },
      { word: 'мұшақ', start: 1, end: 2 },
      { word: 'деген', start: 2, end: 3 },
      { word: 'нәрсе', start: 3, end: 4 },
      { word: 'кереке', start: 4, end: 5 },
    ];
    const out = alignTextToWordTimings(timed, 'осы мұқият нәрсе керек');

    expect(out.map((w) => w.word)).toEqual(['осы', 'мұқият', 'нәрсе', 'керек']);
    expect(out[0].start).toBe(0);
    expect(out[3].start).toBe(4);
    expect(out[3].end).toBe(5);
  });

  it('keeps Russian inserts on their own moment', () => {
    const timed = [
      { word: 'айтқанда', start: 0, end: 1 },
      { word: 'просто', start: 1, end: 2 },
      { word: 'тяжко', start: 2, end: 3 },
      { word: 'солай', start: 3, end: 4 },
    ];
    const out = alignTextToWordTimings(timed, 'айтқанда просто тяжко солай');
    expect(out[1]).toEqual({ word: 'просто', start: 1, end: 2 });
    expect(out[2]).toEqual({ word: 'тяжко', start: 2, end: 3 });
  });

  it('falls back to spreading when the two readings share nothing', () => {
    // Nothing matches, so anchoring would be coincidence. The old behaviour
    // is the honest one here: spread the words across the timeline.
    const timed = [
      { word: 'aaa', start: 0, end: 1 },
      { word: 'bbb', start: 1, end: 2 },
      { word: 'ccc', start: 2, end: 3 },
    ];
    const out = alignTextToWordTimings(timed, 'ззз ыыы ююю ээээ');
    expect(out).toHaveLength(4);
    expect(out[0].start).toBe(0);
    expect(out[out.length - 1].end).toBeCloseTo(3, 5);
  });

  it('never runs backwards, whatever the anchors say', () => {
    const timed = Array.from({ length: 12 }, (_unused, i) => ({ word: `сөз${i}`, start: i, end: i + 1 }));
    const out = alignTextToWordTimings(timed, Array.from({ length: 17 }, (_unused, i) => `сөз${i}`).join(' '));
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start - 1e-9);
      expect(out[i].end).toBeGreaterThanOrEqual(out[i].start - 1e-9);
    }
  });
});
