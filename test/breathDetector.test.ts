import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BREATH_OPTIONS,
  estimateLevels,
  findBreaths,
  gapsBetweenWords,
  type EnergyPoint,
} from '../src/breathDetector';
import type { TranscriptWord } from '../src/smartCut';

// Builds a profile at 50ms steps from a list of [seconds, dB] segments.
function profile(segments: Array<[number, number, number]>): EnergyPoint[] {
  const points: EnergyPoint[] = [];
  for (const [from, to, db] of segments) {
    for (let t = from; t < to; t += 0.05) points.push({ timeSec: Number(t.toFixed(3)), db });
  }
  return points;
}

describe('estimateLevels', () => {
  it('describes the recording, not its loudest accident', () => {
    // One click at 0dB must not become "the speech level" and drag every
    // threshold with it.
    const points = profile([[0, 5, -45]]).concat([{ timeSec: 5, db: 0 }]);
    const levels = estimateLevels(points)!;
    expect(levels.speechDb).toBeLessThan(-30);
  });

  it('declines to guess from too few points', () => {
    expect(estimateLevels([{ timeSec: 0, db: -30 }])).toBeNull();
  });
});

describe('gapsBetweenWords', () => {
  const words: TranscriptWord[] = [
    { word: 'а', start: 1, end: 1.5 },
    { word: 'б', start: 3, end: 3.5 },
  ];

  it('covers before, between and after', () => {
    const gaps = gapsBetweenWords(words, 5, 0);
    expect(gaps).toEqual([
      { start: 0, end: 1 },
      { start: 1.5, end: 3 },
      { start: 3.5, end: 5 },
    ]);
  });

  it('keeps clear of the words themselves', () => {
    // An inhale starts before the model's boundary; cutting up to it clips
    // the consonant.
    const [, middle] = gapsBetweenWords(words, 5, 0.1);
    expect(middle.start).toBeCloseTo(1.6, 5);
    expect(middle.end).toBeCloseTo(2.9, 5);
  });

  it('ignores overlapping words rather than producing a negative gap', () => {
    const overlapping: TranscriptWord[] = [
      { word: 'а', start: 1, end: 2 },
      { word: 'б', start: 1.5, end: 2.5 },
    ];
    for (const gap of gapsBetweenWords(overlapping, 4, 0)) {
      expect(gap.end).toBeGreaterThan(gap.start);
    }
  });
});

describe('findBreaths', () => {
  const words: TranscriptWord[] = [
    { word: 'первое', start: 0, end: 1 },
    { word: 'второе', start: 2.5, end: 3.5 },
  ];

  it('finds an audible sound between words that is not speech', () => {
    const points = profile([
      [0, 1, -20],      // speech
      [1, 1.4, -55],    // room
      [1.4, 1.9, -38],  // breath: above the room, below the voice
      [1.9, 2.5, -55],
      [2.5, 3.5, -20],  // speech
    ]);
    const found = findBreaths(points, words, 3.5);
    expect(found).toHaveLength(1);
    expect(found[0].start).toBeCloseTo(1.4, 1);
    expect(found[0].end).toBeCloseTo(1.85, 1);
  });

  it('leaves silence alone — there is nothing there to remove', () => {
    const points = profile([[0, 1, -20], [1, 2.5, -55], [2.5, 3.5, -20]]);
    expect(findBreaths(points, words, 3.5)).toEqual([]);
  });

  it('keeps speech the model missed', () => {
    // At speech level between two words this is a word, not a breath, and
    // removing it would cut a syllable out of the sentence.
    const points = profile([[0, 1, -20], [1, 1.2, -55], [1.2, 2.2, -21], [2.2, 2.5, -55], [2.5, 3.5, -20]]);
    expect(findBreaths(points, words, 3.5)).toEqual([]);
  });

  it('ignores a stretch too long to be one breath', () => {
    const points = profile([
      [0, 1, -20],
      [1, 1.1, -55],
      [1.1, 2.4, -38], // 1.3s — background, not a breath
      [2.5, 3.5, -20],
    ]);
    expect(findBreaths(points, words, 3.5, { ...DEFAULT_BREATH_OPTIONS, maxDurationSec: 1.2 })).toEqual([]);
  });

  it('ignores a click too short to be one', () => {
    const points = profile([[0, 1, -20], [1, 1.05, -38], [1.05, 2.5, -55], [2.5, 3.5, -20]]);
    expect(findBreaths(points, words, 3.5)).toEqual([]);
  });

  it('never cuts inside a word', () => {
    const points = profile([[0, 3.5, -38]]);
    for (const breath of findBreaths(points, words, 3.5)) {
      for (const word of words) {
        expect(breath.start >= word.end || breath.end <= word.start).toBe(true);
      }
    }
  });

  it('returns nothing for a recording with no dynamic range', () => {
    // Constant tone: no band exists between floor and speech, so any
    // threshold inside it would be arbitrary.
    expect(findBreaths(profile([[0, 3.5, -30]]), words, 3.5)).toEqual([]);
    expect(findBreaths([], words, 3.5)).toEqual([]);
  });
});
