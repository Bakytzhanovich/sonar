import type { TranscriptWord } from './smartCut';

// Finding breaths and mouth noise, which no transcript will ever mark.
//
// The speech model emits words. A breath is not a word, so it comes back as
// nothing at all — the gap between two words looks identical whether the
// speaker was silent or audibly gasping. Smart Cut then keeps the gap if it
// is shorter than the pause threshold, and the breath survives into the
// render. This pass looks at the signal instead of the transcript.
//
// The shape it looks for: a stretch BETWEEN words, quieter than speech but
// clearly louder than the room, lasting a fraction of a second. Louder than
// that and it is probably speech the model missed — which must be kept, and
// is the reason for the upper bound.

export interface EnergyPoint {
  timeSec: number;
  /** RMS in dBFS; roughly -90 for digital silence, -20 for normal speech. */
  db: number;
}

export interface BreathOptions {
  /** Shorter than this is a click or a transient, not a breath. */
  minDurationSec: number;
  /** Longer than this is speech, background, or music — never one breath. */
  maxDurationSec: number;
  /**
   * How far above the noise floor a stretch must sit to count as a sound at
   * all. Below it there is nothing to remove.
   */
  aboveFloorDb: number;
  /**
   * How far BELOW the speech level it must stay. A breath is quieter than
   * the voice that made it; anything approaching speech level is speech.
   */
  belowSpeechDb: number;
  /** Ignore anything this close to a word — the tail of the word itself. */
  wordPaddingSec: number;
}

export const DEFAULT_BREATH_OPTIONS: BreathOptions = {
  minDurationSec: 0.12,
  maxDurationSec: 1.2,
  aboveFloorDb: 6,
  belowSpeechDb: 8,
  // An inhale often starts before the model's word boundary; cutting right
  // up to it clips the consonant.
  wordPaddingSec: 0.06,
};

export interface Interval {
  start: number;
  end: number;
}

/**
 * The noise floor and the speech level of a recording, as percentiles of its
 * energy profile.
 *
 * Percentiles rather than min/max: a single click sets the maximum and a
 * single dropout sets the minimum, and either would move a threshold derived
 * from them. The 10th and 90th describe the recording instead of its
 * accidents.
 */
export function estimateLevels(profile: EnergyPoint[]): { floorDb: number; speechDb: number } | null {
  const usable = profile.map((p) => p.db).filter((db) => Number.isFinite(db)).sort((a, b) => a - b);
  if (usable.length < 8) return null;

  const at = (fraction: number) => usable[Math.min(usable.length - 1, Math.floor(usable.length * fraction))];
  return { floorDb: at(0.1), speechDb: at(0.9) };
}

/** Stretches of the timeline that no word occupies, with padding applied. */
export function gapsBetweenWords(words: TranscriptWord[], durationSec: number, paddingSec: number): Interval[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let cursor = 0;

  for (const word of sorted) {
    const start = cursor + paddingSec;
    const end = word.start - paddingSec;
    if (end > start) gaps.push({ start, end });
    cursor = Math.max(cursor, word.end);
  }

  const tailStart = cursor + paddingSec;
  if (durationSec - paddingSec > tailStart) gaps.push({ start: tailStart, end: durationSec - paddingSec });
  return gaps;
}

/**
 * Breath-like intervals: audible, quieter than speech, short, between words.
 *
 * Returns intervals to remove. Deliberately conservative — a missed breath
 * is a slightly untidy edit, while a wrongly removed one is a missing
 * syllable in a client's video.
 */
export function findBreaths(
  profile: EnergyPoint[],
  words: TranscriptWord[],
  durationSec: number,
  options: BreathOptions = DEFAULT_BREATH_OPTIONS
): Interval[] {
  const levels = estimateLevels(profile);
  if (!levels || profile.length === 0) return [];

  const floorCeiling = levels.floorDb + options.aboveFloorDb;
  const speechFloor = levels.speechDb - options.belowSpeechDb;
  // A recording with no dynamic range at all — constant tone, or silence —
  // leaves no band for a breath to live in, and any threshold picked inside
  // it would be arbitrary.
  if (speechFloor <= floorCeiling) return [];

  const isBreathLevel = (db: number) => db > floorCeiling && db < speechFloor;
  const breaths: Interval[] = [];

  for (const gap of gapsBetweenWords(words, durationSec, options.wordPaddingSec)) {
    let runStart: number | null = null;
    let lastTime = gap.start;

    for (const point of profile) {
      if (point.timeSec < gap.start || point.timeSec > gap.end) continue;

      if (isBreathLevel(point.db)) {
        if (runStart === null) runStart = point.timeSec;
        lastTime = point.timeSec;
      } else if (runStart !== null) {
        pushIfBreath(breaths, runStart, lastTime, options);
        runStart = null;
      }
    }
    if (runStart !== null) pushIfBreath(breaths, runStart, Math.min(lastTime, gap.end), options);
  }

  return breaths;
}

function pushIfBreath(out: Interval[], start: number, end: number, options: BreathOptions): void {
  const duration = end - start;
  if (duration >= options.minDurationSec && duration <= options.maxDurationSec) {
    out.push({ start, end });
  }
}
