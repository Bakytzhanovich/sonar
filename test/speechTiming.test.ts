import { describe, it, expect } from 'vitest';
import { MIN_WORD_SEC, silenceThresholdDb, tightenWordsToSpeech } from '../src/speechTiming';
import type { EnergyPoint } from '../src/breathDetector';

// Pure, and deliberately so: this decides where a word ends, and getting it
// wrong is silent in both directions. Too timid and the pauses stay, which is
// the complaint this exists to answer; too eager and it deletes the middle of
// somebody's sentence. Neither shows up anywhere except in a finished video.

const LEVELS = { floorDb: -76, speechDb: -22 };
const THRESHOLD = silenceThresholdDb(LEVELS);
const LOUD = -20;
const QUIET = -70;
const STEP = 0.064;

/** A profile built from spans of [seconds, dB]. */
function profileOf(spans: Array<[number, number, number]>): EnergyPoint[] {
  const points: EnergyPoint[] = [];
  for (const [from, to, db] of spans) {
    for (let t = from; t < to - 1e-9; t += STEP) points.push({ timeSec: Number(t.toFixed(3)), db });
  }
  return points.sort((a, b) => a.timeSec - b.timeSec);
}

describe('silenceThresholdDb', () => {
  it('sits well clear of both speech and the noise floor', () => {
    // The margin is the point: swept against a real recording, everything from
    // a quarter to four fifths of the way down found the same silences. This
    // guards the property, not the constant.
    expect(THRESHOLD).toBeLessThan(LEVELS.speechDb - 10);
    expect(THRESHOLD).toBeGreaterThan(LEVELS.floorDb + 10);
  });
});

describe('tightenWordsToSpeech', () => {
  it('leaves a word that speaks for its whole span alone', () => {
    const profile = profileOf([[0, 2, LOUD]]);
    const words = [{ word: 'привет', start: 0, end: 1 }];
    const result = tightenWordsToSpeech(words, profile, LEVELS);
    expect(result.words).toEqual(words);
    expect(result.tightenedCount).toBe(0);
  });

  it('pulls back a word stretched over the silence that follows it', () => {
    // The case that started this: whisper gave a single "если" a 9.1s span
    // because it ran to the next word instead of stopping with the voice.
    const profile = profileOf([[0, 0.5, LOUD], [0.5, 9, QUIET], [9, 10, LOUD]]);
    const words = [{ word: 'если', start: 0, end: 9 }, { word: 'ты', start: 9, end: 9.5 }];
    const result = tightenWordsToSpeech(words, profile, LEVELS);

    expect(result.words[0].end).toBeGreaterThan(0.4);
    expect(result.words[0].end).toBeLessThan(0.8);
    // Which is the whole point: a gap now exists where the silence is, and
    // planSmartCut can see it.
    expect(result.words[1].start - result.words[0].end).toBeGreaterThan(8);
    expect(result.reclaimedSec).toBeGreaterThan(8);
  });

  it('refuses to trim at a pause that has more speech after it', () => {
    // The regression this caught in review: trimming at the last quiet run
    // anywhere in the span deleted 2.2s of a real sentence, because the word
    // held a short pause in its middle and kept talking afterwards.
    const profile = profileOf([[0, 1, LOUD], [1, 1.4, QUIET], [1.4, 4, LOUD]]);
    const words = [{ word: 'ты', start: 0, end: 4 }];
    const result = tightenWordsToSpeech(words, profile, LEVELS);
    expect(result.words[0].end).toBe(4);
    expect(result.tightenedCount).toBe(0);
  });

  it('steps over the next word bleeding into the end of this one', () => {
    // A single loud sample at the very end is the next syllable arriving
    // early, not this word still going. Without the allowance it hides the
    // entire pause and nothing is trimmed at all.
    const profile = profileOf([[0, 0.4, LOUD], [0.4, 5, QUIET], [5, 5.15, LOUD]]);
    const words = [{ word: 'если', start: 0, end: 5.15 }];
    const result = tightenWordsToSpeech(words, profile, LEVELS);
    expect(result.words[0].end).toBeLessThan(0.8);
  });

  it('moves the start instead when the word sits in front of its own sound', () => {
    const profile = profileOf([[0, 3, QUIET], [3, 3.6, LOUD]]);
    const words = [{ word: 'по', start: 0, end: 3.6 }];
    const result = tightenWordsToSpeech(words, profile, LEVELS);
    expect(result.words[0].start).toBeGreaterThan(2.5);
    expect(result.words[0].end).toBe(3.6);
  });

  it('never shortens a word out of existence', () => {
    const profile = profileOf([[0, 4, QUIET]]);
    const words = [{ word: 'ээ', start: 0, end: 4 }];
    const result = tightenWordsToSpeech(words, profile, LEVELS);
    const w = result.words[0];
    expect(w.end - w.start).toBeGreaterThanOrEqual(MIN_WORD_SEC - 1e-9);
  });

  it('leaves everything alone when there is no profile to measure', () => {
    // A recording too short to profile, or an analysis that failed, must not
    // silently rewrite the timings it could not check.
    const words = [{ word: 'привет', start: 0, end: 9 }];
    expect(tightenWordsToSpeech(words, [], LEVELS).words).toEqual(words);
    expect(tightenWordsToSpeech([], profileOf([[0, 1, LOUD]]), LEVELS).words).toEqual([]);
  });

  it('keeps words in order and never lets one end before it starts', () => {
    const profile = profileOf([[0, 0.3, LOUD], [0.3, 6, QUIET], [6, 8, LOUD]]);
    const words = [
      { word: 'раз', start: 0, end: 6 },
      { word: 'два', start: 6, end: 7 },
      { word: 'три', start: 7, end: 8 },
    ];
    const result = tightenWordsToSpeech(words, profile, LEVELS);
    for (const w of result.words) expect(w.end).toBeGreaterThan(w.start);
    for (let i = 1; i < result.words.length; i++) {
      expect(result.words[i].start).toBeGreaterThanOrEqual(result.words[i - 1].start);
    }
  });
});
