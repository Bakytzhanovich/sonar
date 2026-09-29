import { describe, it, expect } from 'vitest';
import { pickPreviewWindow } from '../src/previewWindow';
import type { TranscriptWord } from '../src/smartCut';

function words(...spec: Array<[string, number, number]>): TranscriptWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

function total(window: Array<{ start: number; end: number }>): number {
  return window.reduce((sum, s) => sum + (s.end - s.start), 0);
}

describe('pickPreviewWindow', () => {
  it('takes the target length from a single long segment', () => {
    const window = pickPreviewWindow([{ start: 0, end: 30 }], words(['раз', 1, 1.5], ['два', 2, 2.5]), 4)!;

    expect(window).toHaveLength(1);
    expect(window[0].start).toBeCloseTo(0.85, 2);
    expect(total(window)).toBeCloseTo(4, 2);
  });

  // The bug this function was rewritten for. A real recording came out of
  // Smart Cut as five segments of 0.8 to 2.1 seconds, and taking the preview
  // from the first one holding speech produced a 0.76-second flash.
  it('spans several short segments rather than flashing the first one', () => {
    const segments = [
      { start: 0, end: 0.76 },
      { start: 2.88, end: 4.1 },
      { start: 4.48, end: 6.58 },
      { start: 9.22, end: 11.26 },
    ];
    const window = pickPreviewWindow(segments, words(['привет', 0.3, 0.76], ['сегодня', 2.9, 3.4]), 4)!;

    expect(window.length).toBeGreaterThan(1);
    expect(total(window)).toBeCloseTo(4, 1);
  });

  // The preview is of the cut, so it must not include footage the cut drops.
  it('never returns time outside the kept segments', () => {
    const segments = [{ start: 10, end: 12 }, { start: 20, end: 22 }];
    const window = pickPreviewWindow(segments, words(['слово', 10.5, 11], ['второе', 20.5, 21]), 10)!;

    for (const piece of window) {
      const inside = segments.some((s) => piece.start >= s.start && piece.end <= s.end);
      expect(inside).toBe(true);
    }
  });

  // Opening on the padding Smart Cut left around the speech would spend a
  // quarter of a four-second preview on nothing.
  it('starts at the speech rather than at the segment edge', () => {
    const window = pickPreviewWindow([{ start: 0, end: 20 }], words(['поздно', 8, 8.6], ['ещё', 9, 9.4]), 4)!;
    expect(window[0].start).toBeGreaterThan(7);
  });

  it('skips segments that come before the first spoken word', () => {
    const window = pickPreviewWindow(
      [{ start: 0, end: 5 }, { start: 20, end: 30 }],
      words(['привет', 21, 21.6]),
      4
    )!;

    expect(window[0].start).toBeGreaterThan(20);
  });

  // Music, or a cut that kept only silence. Rendering nothing is honest.
  it('returns null when there is no speech anywhere in the cut', () => {
    expect(pickPreviewWindow([{ start: 0, end: 10 }], [], 4)).toBeNull();
    expect(pickPreviewWindow([], words(['раз', 1, 2]), 4)).toBeNull();
    expect(pickPreviewWindow([{ start: 0, end: 5 }], words(['позже', 50, 51]), 4)).toBeNull();
  });

  // Under a second reads as a glitch rather than as an answer.
  it('refuses a cut with too little left to be worth watching', () => {
    expect(pickPreviewWindow([{ start: 0, end: 0.7 }], words(['да', 0.1, 0.6]), 4)).toBeNull();
  });

  it('gives back everything there is when the cut is shorter than the target', () => {
    const window = pickPreviewWindow(
      [{ start: 0, end: 1.5 }, { start: 3, end: 4.2 }],
      words(['раз', 0.1, 0.8], ['два', 3.1, 3.9]),
      10
    )!;

    expect(total(window)).toBeCloseTo(2.7, 1);
  });
});
