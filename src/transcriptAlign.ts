import type { TranscriptWord } from './smartCut';

// Whisper (whisper-1) is the only OpenAI transcription model that returns
// word-level timestamps, and Smart Cut cannot work without them. But on
// low-resource languages — Kazakh above all, which is the product's home
// market — it produces phonetic nonsense: "ол мұшақ жүргерек" where the
// speaker said "ол мұқият жүру керек". gpt-4o-transcribe gets that sentence
// right, but refuses verbose_json and returns no timings at all.
//
// So we take the grid from one model and the words from the other. Cutting
// pauses only needs the grid (silence between words), which whisper-1 gets
// right regardless of how badly it guessed the words themselves; only the
// burned-in captions need the text to be true.

// Punctuation is kept on the word — captions read better with it, and
// smartCut's own normalizeWord strips it before matching filler words.
export function splitIntoWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Re-labels a timed word list with the words of a more accurate transcript of
 * the same audio, keeping the original timings.
 *
 * The two models disagree on word count (they segment speech differently), so
 * the mapping is positional rather than one-to-one: replacement word i covers
 * the timed slots that fall in its proportional share of the timeline. Within
 * a shared slot the span is divided evenly, so captions advance at roughly
 * speech rate instead of all landing at once.
 *
 * This is an approximation — a caption can sit a fraction of a second off the
 * word being spoken. That is a far better failure than the alternative, which
 * is burning confident gibberish into a client's video.
 */
export function alignTextToWordTimings(timed: TranscriptWord[], replacementText: string): TranscriptWord[] {
  const words = splitIntoWords(replacementText);
  if (timed.length === 0 || words.length === 0) return timed;

  // Equal counts is the common case for short clips and needs no stretching,
  // so keep the exact timings rather than routing through the math below.
  if (words.length === timed.length) {
    return timed.map((slot, i) => ({ ...slot, word: words[i] }));
  }

  const out: TranscriptWord[] = [];
  for (let i = 0; i < words.length; i++) {
    // Half-open slot range [from, to) for this word, clamped so the last
    // word always reaches the final slot even with rounding.
    const from = Math.min(Math.floor((i * timed.length) / words.length), timed.length - 1);
    const to = Math.max(Math.min(Math.floor(((i + 1) * timed.length) / words.length), timed.length), from + 1);

    const start = timed[from].start;
    const end = timed[to - 1].end;

    // More words than slots: several words share one slot, so split it.
    // Without this they would all carry identical timings and the caption
    // renderer would highlight them simultaneously.
    const sharers = words.length > timed.length ? countSharers(words.length, timed.length, from) : 1;
    if (sharers > 1) {
      const indexInSlot = i - firstWordOfSlot(words.length, timed.length, from);
      const step = (end - start) / sharers;
      out.push({
        word: words[i],
        start: start + step * indexInSlot,
        end: start + step * (indexInSlot + 1),
      });
    } else {
      out.push({ word: words[i], start, end });
    }
  }

  return out;
}

// How many replacement words map onto slot `slot`.
function countSharers(wordCount: number, slotCount: number, slot: number): number {
  let n = 0;
  for (let i = 0; i < wordCount; i++) {
    if (Math.min(Math.floor((i * slotCount) / wordCount), slotCount - 1) === slot) n++;
  }
  return n;
}

// Index of the first replacement word mapping onto slot `slot`.
function firstWordOfSlot(wordCount: number, slotCount: number, slot: number): number {
  for (let i = 0; i < wordCount; i++) {
    if (Math.min(Math.floor((i * slotCount) / wordCount), slotCount - 1) === slot) return i;
  }
  return 0;
}

// Languages where whisper-1's transcript is not trustworthy enough to burn
// into a video, so the pipeline pays for a second call to get the text right.
// Whisper reports the language as an English name in verbose_json ("kazakh"),
// but an explicit language= request echoes the ISO code back, so both spellings
// are listed.
const LOW_CONFIDENCE_LANGUAGES = new Set(['kazakh', 'kk', 'kyrgyz', 'ky', 'uzbek', 'uz', 'tajik', 'tg']);

export function needsTextCorrection(language: string | null): boolean {
  if (!language) return false;
  return LOW_CONFIDENCE_LANGUAGES.has(language.trim().toLowerCase());
}
