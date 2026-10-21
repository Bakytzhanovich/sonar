import { describe, it, expect } from 'vitest';
import { cutSpan, isWordKept, keepSpan, spanOfWords } from '../src/manualCut';

// "раз два три четыре" with pauses between them, in a 10-second clip.
const words = [
  { start: 1, end: 2 },
  { start: 3, end: 4 },
  { start: 5, end: 6 },
  { start: 7, end: 8 },
];

describe('cutting by words', () => {
  it('spans the words and half of each pause around them', () => {
    expect(spanOfWords(words, 1, 2, 10)).toEqual({ start: 2.5, end: 6.5 });
    // Selected backwards — same span.
    expect(spanOfWords(words, 2, 1, 10)).toEqual({ start: 2.5, end: 6.5 });
  });

  it('runs to the edge of the clip when nothing is said beyond the selection', () => {
    expect(spanOfWords(words, 0, 0, 10)).toEqual({ start: 0, end: 2.5 });
    expect(spanOfWords(words, 3, 3, 10)).toEqual({ start: 6.5, end: 10 });
  });

  it('takes the span out of a segment and keeps both sides', () => {
    expect(cutSpan([{ start: 0, end: 10 }], { start: 2.5, end: 6.5 })).toEqual([
      { start: 0, end: 2.5 },
      { start: 6.5, end: 10 },
    ]);
  });

  it('drops a crumb too short to be footage rather than keeping it', () => {
    expect(cutSpan([{ start: 0, end: 10 }], { start: 0.1, end: 9.95 })).toEqual([]);
  });

  it('leaves segments the span does not touch alone', () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 7, end: 10 },
    ];
    expect(cutSpan(segments, { start: 3, end: 5 })).toEqual(segments);
  });

  it('puts a span back and merges it with what it touches', () => {
    const cut = cutSpan([{ start: 0, end: 10 }], spanOfWords(words, 1, 2, 10));
    expect(keepSpan(cut, spanOfWords(words, 1, 2, 10))).toEqual([{ start: 0, end: 10 }]);
  });

  it('knows which words the cut keeps', () => {
    const cut = cutSpan([{ start: 0, end: 10 }], spanOfWords(words, 1, 1, 10));
    expect(words.map((w) => isWordKept(w, cut))).toEqual([true, false, true, true]);
  });
});
