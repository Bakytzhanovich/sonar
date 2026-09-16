// Module 8, Level 3 (own FFmpeg engine) — stage 3 of the pipeline: turn a
// word-level transcript into the list of time ranges worth keeping.
//
// This file is deliberately pure: no ffmpeg, no network, no database. Every
// judgement call about how the edit *sounds* lives here, which is what makes
// it unit-testable without a video file — the rest of the pipeline is
// plumbing around this function.

export interface TranscriptWord {
  word: string;
  start: number; // seconds from the start of the source
  end: number;
}

export interface KeepSegment {
  start: number;
  end: number;
}

export interface SmartCutOptions {
  // Pauses shorter than this stay untouched — they are the natural rhythm of
  // speech, not dead air. The ТЗ asks for 0.7s.
  maxPauseSec: number;
  // How much silence to LEAVE on each side of a cut. Cutting a pause down to
  // exactly zero clips the consonants that trail off at the end of a word and
  // the breath that starts the next one, which is what makes naive
  // auto-editors sound chopped. A 0.7s pause therefore becomes 2*padding,
  // not 0.
  paddingSec: number;
  // A removal shorter than this is not worth making: the cut itself costs a
  // potential artefact at the join and saves a few frames of runtime.
  minRemovalSec: number;
  // A kept fragment shorter than this, wedged between two removals, is a
  // crumb — a syllable with no context. Dropping it merges the neighbouring
  // removals into one clean cut.
  minSegmentSec: number;
  // Hard ceiling on the number of joins. See planSmartCut's degrade path.
  maxSegments: number;
  // Lowercased, punctuation-free filler tokens to drop outright.
  fillerWords: string[];
}

export const DEFAULT_SMART_CUT_OPTIONS: SmartCutOptions = {
  maxPauseSec: 0.7,
  paddingSec: 0.12,
  minRemovalSec: 0.08,
  minSegmentSec: 0.15,
  maxSegments: 300,
  // Whisper transcribes hesitation sounds as words, so a token list catches
  // them. Note what this does NOT catch: breaths and sighs, which Whisper
  // does not emit at all — removing those needs an energy-based pass over the
  // waveform and is deliberately out of scope for this iteration.
  fillerWords: ['ээ', 'эээ', 'эм', 'ммм', 'мм', 'ну', 'вот', 'типа', 'кароче', 'короче', 'uh', 'um', 'uhh', 'erm', 'hmm'],
};

export interface SmartCutPlan {
  segments: KeepSegment[];
  sourceDurationSec: number;
  keptDurationSec: number;
  removedDurationSec: number;
  droppedFillerCount: number;
  // True when maxSegments forced us to keep only the longest pauses. The job
  // still succeeds — a slightly looser edit is a far better outcome than a
  // failed render — but the flag is surfaced so the UI can say so.
  degraded: boolean;
}

interface Interval {
  start: number;
  end: number;
}

// Whisper returns words with punctuation attached ("вот,") and inconsistent
// case. Normalising before comparing against fillerWords is what makes the
// list actually match anything.
function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[.,!?;:—–-]/g, '')
    .replace(/[«»"'`]/g, '')
    .trim();
}

// Whisper occasionally emits a word whose start precedes the previous word's
// end, or whose end runs past the media duration (it times against the audio
// stream, which can be marginally longer than the container). Both break the
// interval arithmetic below — a negative-length gap silently becomes a
// removal — so the transcript is repaired into a sorted, clamped, monotonic
// sequence before anything else looks at it.
function sanitizeWords(words: TranscriptWord[], durationSec: number): TranscriptWord[] {
  const sorted = [...words]
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);

  const out: TranscriptWord[] = [];
  let cursor = 0;
  for (const word of sorted) {
    const start = Math.min(Math.max(word.start, cursor), durationSec);
    const end = Math.min(Math.max(word.end, start), durationSec);
    if (end <= start) continue;
    out.push({ word: word.word, start, end });
    cursor = end;
  }
  return out;
}

// Merges overlapping removals, and also merges two removals separated by less
// than minSegmentSec — the fragment between them is too short to be worth
// keeping, so absorbing it produces one clean cut instead of two cuts around
// a stutter.
function mergeRemovals(removals: Interval[], minSegmentSec: number): Interval[] {
  const sorted = [...removals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start - last.end < minSegmentSec) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function complement(removals: Interval[], durationSec: number, minSegmentSec: number): KeepSegment[] {
  const segments: KeepSegment[] = [];
  let cursor = 0;
  for (const removal of removals) {
    if (removal.start - cursor >= minSegmentSec) segments.push({ start: cursor, end: removal.start });
    cursor = Math.max(cursor, removal.end);
  }
  if (durationSec - cursor >= minSegmentSec) segments.push({ start: cursor, end: durationSec });
  return segments;
}

function totalLength(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

export function planSmartCut(
  words: TranscriptWord[],
  durationSec: number,
  options: SmartCutOptions = DEFAULT_SMART_CUT_OPTIONS
): SmartCutPlan {
  const { maxPauseSec, paddingSec, minRemovalSec, minSegmentSec, maxSegments, fillerWords } = options;
  const fillers = new Set(fillerWords.map(normalizeWord));
  const clean = sanitizeWords(words, durationSec);

  // No usable transcript — a music-only clip, or a failed transcription that
  // still returned 200. Keeping the source whole is the honest outcome:
  // silently returning zero segments would render an empty file.
  if (clean.length === 0) {
    return {
      segments: durationSec > 0 ? [{ start: 0, end: durationSec }] : [],
      sourceDurationSec: durationSec,
      keptDurationSec: durationSec,
      removedDurationSec: 0,
      droppedFillerCount: 0,
      degraded: false,
    };
  }

  const kept: TranscriptWord[] = [];
  const removals: Interval[] = [];
  let droppedFillerCount = 0;

  for (const word of clean) {
    if (fillers.has(normalizeWord(word.word))) {
      droppedFillerCount++;
      removals.push({ start: word.start, end: word.end });
    } else {
      kept.push(word);
    }
  }

  // Gaps considered for removal: before the first word, between consecutive
  // kept words, and after the last. Leading/trailing dead air is measured
  // against 0 and durationSec, which is why a clip that opens with four
  // seconds of the speaker reaching for the record button gets trimmed too.
  const boundaries: Interval[] = [];
  if (kept.length > 0) {
    boundaries.push({ start: 0, end: kept[0].start });
    for (let i = 1; i < kept.length; i++) boundaries.push({ start: kept[i - 1].end, end: kept[i].start });
    boundaries.push({ start: kept[kept.length - 1].end, end: durationSec });
  }

  for (const gap of boundaries) {
    if (gap.end - gap.start <= maxPauseSec) continue;
    // The padding is what survives; everything between is cut. Clamped so a
    // gap at the very start or end doesn't pad outside the media.
    const start = Math.min(gap.start + paddingSec, gap.end);
    const end = Math.max(gap.end - paddingSec, start);
    if (end - start >= minRemovalSec) removals.push({ start, end });
  }

  const merged = mergeRemovals(removals.filter((r) => r.end - r.start >= minRemovalSec), minSegmentSec);
  let effective = merged;
  let degraded = false;

  // Every removal becomes a join in the ffmpeg filter graph, and the graph is
  // built per segment — a few hundred is fine, a few thousand makes the
  // render unreasonably slow and can exceed ffmpeg's own limits. Rather than
  // fail a job outright, fall back to cutting only the longest pauses: the
  // result is a looser edit of the same video, which the user can still use.
  if (merged.length + 1 > maxSegments) {
    effective = mergeRemovals(
      [...merged].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, Math.max(0, maxSegments - 1)),
      minSegmentSec
    );
    degraded = true;
  }

  const segments = complement(effective, durationSec, minSegmentSec);
  const keptDurationSec = totalLength(segments);

  return {
    segments,
    sourceDurationSec: durationSec,
    keptDurationSec,
    removedDurationSec: Math.max(0, durationSec - keptDurationSec),
    droppedFillerCount,
    degraded,
  };
}
