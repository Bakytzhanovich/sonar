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

  // Try to match the two word lists to each other before falling back to
  // dividing the timeline by position. The models disagree on the words, but
  // they are transcribing the same speech: whisper's Kazakh is phonetic
  // rubbish rather than random — "ол мұшақ жүргерек" against "ол мұқият жүру
  // керек" shares most of its letters — and the Russian it does get right
  // matches outright. Those shared spellings are anchors, and a caption
  // pinned to an anchor lands on the word being spoken instead of near it.
  const anchored = alignByResemblance(timed, words);
  if (anchored) return anchored;

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

// ---- Matching the two readings to each other -----------------------------

// Punctuation and case carry no information about which word this is.
function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * How alike two spellings are, from 0 (nothing in common) to 1 (identical).
 *
 * Levenshtein over characters, scaled by the longer word. Crude next to a
 * phonetic model, and enough here: it is separating "мұқият" from "мұшақ"
 * (close) from "энергия" (not), which spelling alone settles.
 */
export function resemblance(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  let prev = Array.from({ length: y.length + 1 }, (_unused, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

// Below this two words are not the same word, however much the alignment
// would like to pair them.
//
// Measured on pairs taken from this product's own Kazakh footage — whisper's
// reading against the corrected one — rather than guessed:
//
//   same word      0.333  мұшақ / мұқият
//                  0.375  жүргерек / жүру
//                  0.462  айтатадығығын / айтады
//                  0.833  кереке / керек
//                  1.000  негізінде / негізінде
//
//   different word 0.125  айту / болғанын      ← the worst case found
//                  0.000  энергия / мұшақ, керек / просто, …
//
// Everything that is the same word scores 0.333 or more; nothing that is a
// different word scores above 0.125. 0.30 sits in the empty band between
// them, clear of both edges.
//
// Not every true pair can be caught: "жақты" for "тяжко" scores 0, because
// whisper heard a different word rather than a mangled one. Those stay
// unanchored and get spread between their neighbours, which is what the
// fallback is for.
const ANCHOR_THRESHOLD = 0.3;

// Enough anchors to trust the alignment rather than the proportional split.
// With fewer, the two readings have almost nothing in common and matching
// them would place words by coincidence — worse than spreading them evenly,
// because it looks deliberate.
const MIN_ANCHOR_FRACTION = 0.15;

/**
 * Pairs replacement words with timed slots by spelling, then gives each
 * matched word its slot's timing and spreads the unmatched ones across the
 * gap between neighbours.
 *
 * Returns null when too few words match to be worth trusting.
 *
 * The search is banded: only slots within `band` positions of a word are
 * considered. The readings run in parallel — neither model reorders speech —
 * so a distant pairing is a false one, and the band keeps a twenty-minute
 * transcript from building a multi-million-cell table.
 */
function alignByResemblance(timed: TranscriptWord[], words: string[]): TranscriptWord[] | null {
  const n = words.length;
  const m = timed.length;
  const band = Math.max(20, Math.abs(n - m) + 10);

  // best[i][j] — score of aligning the first i words with the first j slots.
  // Gaps score 0 rather than negative: a word the other reading simply does
  // not have is normal here, not a penalty to avoid.
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(-Infinity));
  const from: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  best[0][0] = 0;
  for (let i = 1; i <= n; i++) if (Math.abs(i) <= band) { best[i][0] = 0; from[i][0] = 1; }
  for (let j = 1; j <= m; j++) if (Math.abs(j) <= band) { best[0][j] = 0; from[0][j] = 2; }

  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - band);
    const hi = Math.min(m, i + band);
    for (let j = lo; j <= hi; j++) {
      const match = best[i - 1][j - 1] + resemblance(words[i - 1], timed[j - 1].word);
      const skipWord = best[i - 1][j];
      const skipSlot = best[i][j - 1];
      if (match >= skipWord && match >= skipSlot) { best[i][j] = match; from[i][j] = 0; }
      else if (skipWord >= skipSlot) { best[i][j] = skipWord; from[i][j] = 1; }
      else { best[i][j] = skipSlot; from[i][j] = 2; }
    }
  }

  // Walk back, recording which slot each word was paired with.
  const slotOf = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  let anchors = 0;
  while (i > 0 && j > 0) {
    if (!Number.isFinite(best[i][j])) break;
    const step = from[i][j];
    if (step === 0) {
      if (resemblance(words[i - 1], timed[j - 1].word) >= ANCHOR_THRESHOLD) {
        slotOf[i - 1] = j - 1;
        anchors++;
      }
      i--; j--;
    } else if (step === 1) i--;
    else j--;
  }

  if (anchors < Math.max(2, Math.ceil(Math.min(n, m) * MIN_ANCHOR_FRACTION))) return null;
  return spreadBetweenAnchors(timed, words, slotOf);
}

/**
 * Builds the final list: anchored words take their slot's timing, and each
 * run of unanchored words is spread evenly across the time between the
 * anchors on either side.
 */
function spreadBetweenAnchors(timed: TranscriptWord[], words: string[], slotOf: number[]): TranscriptWord[] {
  const out: TranscriptWord[] = new Array(words.length);
  const anchoredIndexes = slotOf.map((slot, i) => (slot >= 0 ? i : -1)).filter((i) => i >= 0);

  for (const i of anchoredIndexes) {
    const slot = timed[slotOf[i]];
    out[i] = { word: words[i], start: slot.start, end: slot.end };
  }

  // Each stretch of unanchored words sits between two known points: the end
  // of the previous anchor and the start of the next. Before the first and
  // after the last anchor, the recording's own edges stand in.
  let cursor = 0;
  for (let k = 0; k <= anchoredIndexes.length; k++) {
    const startIndex = k === 0 ? 0 : anchoredIndexes[k - 1] + 1;
    const endIndex = k === anchoredIndexes.length ? words.length : anchoredIndexes[k];
    const count = endIndex - startIndex;
    if (count <= 0) { cursor = k < anchoredIndexes.length ? anchoredIndexes[k] : cursor; continue; }

    const spanStart = startIndex === 0 ? timed[0].start : out[startIndex - 1].end;
    const spanEnd = endIndex === words.length ? timed[timed.length - 1].end : out[endIndex].start;
    // A span can come out backwards when two anchors overlap; falling back to
    // a zero-length span keeps the order monotonic instead of producing
    // captions that start before the one before them.
    const step = Math.max(0, spanEnd - spanStart) / count;
    for (let w = 0; w < count; w++) {
      out[startIndex + w] = {
        word: words[startIndex + w],
        start: spanStart + step * w,
        end: spanStart + step * (w + 1),
      };
    }
    cursor = endIndex;
  }

  // The captions must cover the speech from end to end. Anchoring can leave
  // the outermost slots unused — the last word matching the second-to-last
  // slot, say — and then the final caption disappears while the speaker is
  // still talking. Only ever widened, never pulled in.
  if (out.length > 0) {
    out[0] = { ...out[0], start: Math.min(out[0].start, timed[0].start) };
    const last = out.length - 1;
    out[last] = { ...out[last], end: Math.max(out[last].end, timed[timed.length - 1].end) };
  }

  return out;
}

// Languages where whisper-1's transcript is not trustworthy enough to burn
// into a video, so the pipeline pays for a second call to get the text right.
// Whisper reports the language as an English name in verbose_json ("kazakh"),
// but an explicit language= request echoes the ISO code back, so both spellings
// are listed.
const LOW_CONFIDENCE_LANGUAGES = new Set(['kazakh', 'kk', 'kyrgyz', 'ky', 'uzbek', 'uz', 'tajik', 'tg']);

// Providers disagree on how they name a language: whisper's verbose_json says
// "kazakh", an explicit language= request echoes "kk", and Google returns the
// full BCP-47 tag "kk-KZ". Matching the bare code against a regioned tag
// fails silently — the caption review and the unreliable-language warning
// would simply never fire on exactly the path they exist for.
export function needsTextCorrection(language: string | null): boolean {
  if (!language) return false;
  const normalized = language.trim().toLowerCase();
  if (LOW_CONFIDENCE_LANGUAGES.has(normalized)) return true;
  // 'kk-kz' -> 'kk'
  const base = normalized.split(/[-_]/)[0];
  return LOW_CONFIDENCE_LANGUAGES.has(base);
}
