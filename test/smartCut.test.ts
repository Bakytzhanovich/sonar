import { describe, it, expect } from 'vitest';
import { DEFAULT_SMART_CUT_OPTIONS, planSmartCut, type TranscriptWord } from '../src/smartCut';

// Builds a transcript from [word, start, end] triples so each test reads as
// the timeline it is actually describing.
function words(...spec: Array<[string, number, number]>): TranscriptWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

const opts = DEFAULT_SMART_CUT_OPTIONS;

describe('planSmartCut', () => {
  it('leaves a continuously spoken clip untouched', () => {
    const plan = planSmartCut(words(['привет', 0, 0.5], ['как', 0.5, 0.9], ['дела', 0.9, 1.4]), 1.4);

    expect(plan.segments).toEqual([{ start: 0, end: 1.4 }]);
    expect(plan.removedDurationSec).toBe(0);
  });

  it('ignores pauses at or below the threshold', () => {
    // 0.7s gap — exactly the threshold, which is "long enough to be natural".
    const plan = planSmartCut(words(['раз', 0, 0.5], ['два', 1.2, 1.7]), 1.7);
    expect(plan.segments).toHaveLength(1);
  });

  it('cuts a long pause but leaves padding on both sides', () => {
    // 3s of silence between two words. Padding is 0.12s per side, so 0.24s
    // of it must survive — a cut straight to zero is what makes an edit
    // sound chopped.
    const plan = planSmartCut(words(['раз', 0, 1], ['два', 4, 5]), 5);

    expect(plan.segments).toEqual([
      { start: 0, end: 1.12 },
      { start: 3.88, end: 5 },
    ]);
    expect(plan.removedDurationSec).toBeCloseTo(2.76, 5);
  });

  it('trims dead air at the start and end of the clip', () => {
    const plan = planSmartCut(words(['слово', 5, 6]), 11);

    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].start).toBeCloseTo(4.88, 5);
    expect(plan.segments[0].end).toBeCloseTo(6.12, 5);
  });

  it('drops filler words and reports how many', () => {
    const plan = planSmartCut(words(['я', 0, 0.3], ['ну', 0.3, 0.6], ['думаю', 0.6, 1.2]), 1.2);

    expect(plan.droppedFillerCount).toBe(1);
    expect(plan.removedDurationSec).toBeGreaterThan(0);
  });

  it('matches filler words regardless of case and trailing punctuation', () => {
    // Whisper returns "Ну," not "ну" — without normalisation the filler list
    // silently matches nothing at all.
    const plan = planSmartCut(words(['Ну,', 0, 0.4], ['поехали', 0.4, 1.2]), 1.2);
    expect(plan.droppedFillerCount).toBe(1);
  });

  it('keeps the source whole when the transcript is empty', () => {
    // A silent clip, or a transcription that returned 200 with no words.
    // Returning zero segments here would render an empty video.
    const plan = planSmartCut([], 12);
    expect(plan.segments).toEqual([{ start: 0, end: 12 }]);
  });

  it('repairs overlapping and out-of-range word timings from Whisper', () => {
    // Second word starts before the first ends, third runs past the media
    // duration. Unrepaired, both produce negative-length gaps and the
    // segments come out unsorted or inverted.
    const plan = planSmartCut(words(['a', 0, 1.0], ['b', 0.8, 1.5], ['c', 1.5, 99]), 3);

    for (const segment of plan.segments) expect(segment.end).toBeGreaterThan(segment.start);
    expect(plan.segments[plan.segments.length - 1].end).toBeLessThanOrEqual(3);
  });

  it('never returns a segment shorter than minSegmentSec', () => {
    const plan = planSmartCut(
      words(['раз', 0, 1], ['ну', 3, 3.05], ['два', 5, 6]),
      6
    );
    for (const segment of plan.segments) {
      expect(segment.end - segment.start).toBeGreaterThanOrEqual(opts.minSegmentSec);
    }
  });

  it('degrades to the longest pauses instead of exceeding maxSegments', () => {
    // 60 words, each separated by a 1s pause, against a ceiling of 10
    // segments. The naive result would be 61 joins; the ffmpeg filter graph
    // is built per segment, so the cap is what keeps the render finite.
    const spec: Array<[string, number, number]> = [];
    for (let i = 0; i < 60; i++) spec.push([`слово${i}`, i * 2, i * 2 + 1]);
    const plan = planSmartCut(spec.map(([w, s, e]) => ({ word: w, start: s, end: e })), 120, {
      ...opts,
      maxSegments: 10,
    });

    expect(plan.degraded).toBe(true);
    expect(plan.segments.length).toBeLessThanOrEqual(10);
    // Still an edit, not a passthrough.
    expect(plan.removedDurationSec).toBeGreaterThan(0);
  });

  it('reports kept and removed durations that add up to the source', () => {
    const plan = planSmartCut(words(['раз', 0, 1], ['два', 6, 7]), 7);
    expect(plan.keptDurationSec + plan.removedDurationSec).toBeCloseTo(7, 5);
  });
});
