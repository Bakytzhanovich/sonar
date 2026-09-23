import type { EnergyPoint } from './breathDetector';
import type { TranscriptWord } from './smartCut';

// Makes word timings honest against the waveform, so that a pause is visible
// as a pause.
//
// Why this has to exist. planSmartCut finds a pause by looking for a gap
// between one word's end and the next word's start — and whisper does not
// leave gaps. It stretches the last word before a silence to cover it, so the
// transcript says someone is talking when the room is empty. Measured on a
// client's 62-second reel: 64 of 65 consecutive word pairs touched within a
// hundredth of a second, and a single "если" carried a span of 9.1 seconds
// across silence the microphone recorded as nothing:
//
//     ненавидишь [41.7-42.4]
//     если       [42.4-51.5]   <- nine seconds of it silent
//     ты         [51.5-51.7]
//
// The cut planner therefore had nothing to cut and removed none of the
// eighteen seconds of dead air in a thirty-seven-second video — the "ИИ
// монтаж" ran and changed nothing, which is exactly what the client reported.
// The same stretched span also kept "если" on screen as a caption for nine
// seconds, which reads as the subtitles freezing.
//
// The repair is to trim each word's end back to where its sound actually
// stops. That is all: no word is dropped, no text is lost, and the whole
// downstream chain then works unchanged — the planner sees real gaps and cuts
// them with its existing padding and minimum-length rules, and captions
// disappear when the speaker stops rather than holding until the next one.
//
// Only the end moves. A pause before a word shows up just as well once the
// PREVIOUS word stops overreaching, so touching starts would be a second way
// to say the same thing, with the added risk of clipping a word's attack.

/**
 * How far below speech level counts as silence, as a fraction of the distance
 * from the speech level down to the noise floor.
 *
 * Not a knife-edge: swept against real audio, every threshold from 0.25 to
 * 0.85 of that distance found the same silences to within three seconds out of
 * eighteen. Speech and silence are separated by tens of decibels, so this
 * picks the middle of a wide valley rather than balancing on an edge.
 */
export const SILENCE_FRACTION = 0.45;

/** Shortest a word may be left after trimming. */
export const MIN_WORD_SEC = 0.08;

/**
 * Shortest run of quiet worth treating as a pause rather than as the dip
 * between two syllables.
 *
 * Below the 0.4s the planner will actually cut at, on purpose: this step only
 * has to describe the recording accurately, and deciding what is worth cutting
 * stays where it already is, with maxPauseSec and the padding rules.
 */
export const MIN_SILENCE_SEC = 0.25;

/**
 * How much sound at the very end of a word's span is treated as the next
 * word's first syllable bleeding in, rather than as this word still speaking.
 *
 * Whisper's boundaries are approximate, so the sample just before a span ends
 * routinely belongs to what comes after it — "если", nine seconds of which is
 * silence, carries a loud sample 0.02s before its end for exactly that reason.
 * Without this allowance that one sample hides the entire pause.
 */
export const MAX_BLEED_SEC = 0.25;

export function silenceThresholdDb(levels: { floorDb: number; speechDb: number }): number {
  return levels.speechDb - (levels.speechDb - levels.floorDb) * SILENCE_FRACTION;
}

/**
 * The spacing between energy samples, read from the profile rather than
 * assumed: it is set by the analysis filter, and a hard-coded guess here would
 * silently mis-place every trimmed edge if that ever changed.
 */
function sampleStep(profile: EnergyPoint[]): number {
  if (profile.length < 2) return 0;
  return Math.max(0, profile[1].timeSec - profile[0].timeSec);
}

export interface TightenResult {
  words: TranscriptWord[];
  /** How much word span stopped covering silence. */
  reclaimedSec: number;
  /** How many words were actually shortened. */
  tightenedCount: number;
}

export function tightenWordsToSpeech(
  words: TranscriptWord[],
  profile: EnergyPoint[],
  levels: { floorDb: number; speechDb: number }
): TightenResult {
  if (words.length === 0 || profile.length < 2) {
    return { words, reclaimedSec: 0, tightenedCount: 0 };
  }

  const threshold = silenceThresholdDb(levels);
  const step = sampleStep(profile);

  let reclaimedSec = 0;
  let tightenedCount = 0;

  // The profile is in time order, and so are the words, so one moving index
  // walks both instead of scanning the whole profile per word — on a long
  // recording that is the difference between linear and quadratic.
  let cursor = 0;
  const out = words.map((word) => {
    while (cursor > 0 && profile[cursor].timeSec > word.start) cursor--;
    while (cursor < profile.length - 1 && profile[cursor].timeSec < word.start) cursor++;

    const lo = cursor;
    let hi = cursor;
    while (hi < profile.length && profile[hi].timeSec < word.end) hi++;
    if (hi <= lo) return word;

    // Every stretch of quiet inside the span that is long enough to be a
    // pause rather than the dip between two syllables.
    const runs: Array<{ start: number; end: number }> = [];
    let open = -1;
    for (let i = lo; i <= hi; i++) {
      const quiet = i < hi && profile[i].db < threshold;
      if (quiet && open < 0) open = i === lo ? word.start : profile[i].timeSec;
      if (!quiet && open >= 0) {
        const end = i < hi ? profile[i].timeSec : word.end;
        if (end - open >= MIN_SILENCE_SEC) runs.push({ start: open, end });
        open = -1;
      }
    }
    if (runs.length === 0) return word;

    let { start, end } = word;

    // Quiet from the word's own start means the sound came after it: whisper
    // placed the word in front of a pause that belongs before it. Moving the
    // start puts the caption where the voice is, and is safe whatever follows
    // — nothing audible is being given away.
    const leading = runs[0].start <= word.start + step ? runs[0] : null;
    if (leading) start = Math.min(leading.end, word.end - MIN_WORD_SEC);

    // At the other end, only a run that reaches the span's end counts, give or
    // take the next word's first syllable arriving early. A pause with real
    // speech after it is not the end of this word, whatever the timings say —
    // trimming at one deleted 2.2 seconds of a sentence before this rule
    // existed, and nothing but the finished video would have shown it.
    const trailing = [...runs].reverse().find((r) => r.end >= word.end - MAX_BLEED_SEC);
    if (trailing && trailing.start > start) end = Math.max(trailing.start, start + MIN_WORD_SEC);

    const tightened = { ...word, start, end };

    const before = word.end - word.start;
    const after = tightened.end - tightened.start;
    if (after < before - 1e-6) {
      reclaimedSec += before - after;
      tightenedCount++;
      return tightened;
    }
    return word;
  });

  return { words: out, reclaimedSec, tightenedCount };
}
