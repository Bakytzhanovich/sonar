import { describe, it, expect } from 'vitest';
import { pickPreviewWindow } from '../src/previewWindow';
import type { TranscriptWord } from '../src/smartCut';

function words(...spec: Array<[string, number, number]>): TranscriptWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

describe('pickPreviewWindow', () => {
  it('takes a window from the first segment that has speech in it', () => {
    const window = pickPreviewWindow(
      [{ start: 0, end: 10 }],
      words(['раз', 1, 1.5], ['два', 2, 2.5], ['три', 3, 3.5]),
      4
    );

    expect(window!.start).toBeCloseTo(0.85, 2);
    expect(window!.end).toBeCloseTo(4.85, 2);
  });

  // A preview of someone silently looking at the camera does not show what
  // the captions look like — it looks like the captions are broken.
  it('skips a silent segment in favour of one with words', () => {
    const window = pickPreviewWindow(
      [{ start: 0, end: 5 }, { start: 20, end: 30 }],
      words(['привет', 21, 21.6], ['мир', 22, 22.5]),
      4
    );

    expect(window!.start).toBeGreaterThan(20);
  });

  // The preview must show the video as it will be, not footage this edit
  // throws away.
  it('never returns a window outside the cut', () => {
    const segments = [{ start: 10, end: 14 }];
    const window = pickPreviewWindow(segments, words(['слово', 11, 11.5], ['второе', 12, 12.5]), 10);

    expect(window!.start).toBeGreaterThanOrEqual(10);
    expect(window!.end).toBeLessThanOrEqual(14);
  });

  // Opening on the padding Smart Cut left around the speech would spend a
  // quarter of a four-second preview on nothing.
  it('starts at the speech rather than at the segment edge', () => {
    const window = pickPreviewWindow([{ start: 0, end: 20 }], words(['поздно', 8, 8.6], ['ещё', 9, 9.4]), 4);
    expect(window!.start).toBeGreaterThan(7);
  });

  it('uses a short segment whole rather than hunting for a longer one', () => {
    const window = pickPreviewWindow(
      [{ start: 0, end: 2 }, { start: 30, end: 40 }],
      words(['два', 0.2, 0.7], ['слова', 1, 1.6], ['потом', 31, 31.5], ['ещё', 32, 32.4]),
      4
    );

    expect(window!.end).toBeLessThanOrEqual(2);
  });

  // Music, or a cut that kept only silence. Rendering nothing is honest.
  it('returns null when there is no speech anywhere in the cut', () => {
    expect(pickPreviewWindow([{ start: 0, end: 10 }], [], 4)).toBeNull();
    expect(pickPreviewWindow([], words(['раз', 1, 2]), 4)).toBeNull();
  });

  it('returns null when every word falls outside the kept segments', () => {
    expect(pickPreviewWindow([{ start: 0, end: 5 }], words(['позже', 50, 51]), 4)).toBeNull();
  });
});
