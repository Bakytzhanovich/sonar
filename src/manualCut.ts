// Editing a cut by its words: select some, cut them, put them back.
//
// Pure, and shared with the browser (CutEditor imports it through
// @shared/manualCut), so what the editor draws is computed by the same code
// the tests check. Segments are keep-segments on the SOURCE timeline, the
// shape the revise endpoint takes.

export interface Span {
  start: number;
  end: number;
}

/** A kept piece shorter than this is a frame or two of noise, not footage. */
export const MIN_PIECE_SEC = 0.2;

/**
 * The stretch of source a run of words occupies — words[from..to] — reaching
 * halfway into the pause on each side. Cutting exactly at the word edges
 * would leave the pauses around them standing, and two half-pauses meeting
 * at the join sound like one natural pause. With no word before (or after),
 * the span runs to the clip's edge: cutting the first words cuts the silence
 * before them too.
 */
export function spanOfWords(words: Span[], from: number, to: number, durationSec: number): Span {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(words.length - 1, Math.max(from, to));
  const before = words[lo - 1];
  const after = words[hi + 1];
  const start = before ? (before.end + words[lo].start) / 2 : 0;
  const end = after ? (words[hi].end + after.start) / 2 : durationSec;
  return { start: Math.max(0, Math.min(start, words[lo].start)), end: Math.min(durationSec, Math.max(end, words[hi].end)) };
}

/** The segments with `span` taken out; crumbs shorter than MIN_PIECE_SEC go with it. */
export function cutSpan(segments: Span[], span: Span): Span[] {
  const out: Span[] = [];
  for (const s of segments) {
    if (span.end <= s.start || span.start >= s.end) {
      out.push({ ...s });
      continue;
    }
    if (span.start - s.start >= MIN_PIECE_SEC) out.push({ start: s.start, end: span.start });
    if (s.end - span.end >= MIN_PIECE_SEC) out.push({ start: span.end, end: s.end });
  }
  return out;
}

/** The segments with `span` kept, merged with anything it touches. */
export function keepSpan(segments: Span[], span: Span): Span[] {
  const sorted = [...segments, span].map((s) => ({ ...s })).sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.01) last.end = Math.max(last.end, s.end);
    else merged.push(s);
  }
  return merged;
}

/** A word is in the cut when its middle falls inside a kept segment. */
export function isWordKept(word: Span, segments: Span[]): boolean {
  const middle = (word.start + word.end) / 2;
  return segments.some((s) => middle >= s.start && middle <= s.end);
}
