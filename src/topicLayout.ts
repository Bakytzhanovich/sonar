// "Тема": a caption look in three layers, laid out from what is being said
// rather than word by word.
//
//   1. the topic's keyword, huge and burgundy, near the top — one word per
//      stretch of talk about one thing, held while that topic lasts;
//   2. a two-tier caption in the lower third: the lead-in words small and
//      spaced out, then the key phrase large, appearing as it is spoken;
//   3. now and then one emotional word in handwriting, tilted, over the
//      caption.
//
// Which word is the topic, where the lead-in ends and which word carries the
// feeling are questions about meaning, so they come from a model, once per
// render, over the finished caption phrases (captionMarkup.ts). This module
// only checks that answer and lays it out — and when there is no answer, it
// has its own plain fallback, so a model that is down never fails a render.

import { pickEmphasis } from './emphasis';
import type { SubtitleChunk, SubtitleStyle, MeasureText } from './subtitles';
import { escapeAssText, formatAssTime } from './subtitles';

/** What the model (or the fallback) decided about the phrases. */
export interface CaptionMarkup {
  /** Consecutive phrases about one thing, and the word that names it. */
  topics: Array<{ from: number; to: number; keyword: string }>;
  /** For each phrase, the index of the first word of its key part. */
  keyStart: number[];
  /** Phrase index → index of the emotional word in it. */
  accents: Array<{ chunk: number; word: number }>;
}

/** A keyword holds at least this long, so it can be read. */
export const MIN_TOPIC_SEC = 2;
/** Handwritten accents are spice: no closer together than this. */
export const ACCENT_GAP_SEC = 10;

/**
 * Takes whatever came back and keeps only what is consistent with the
 * phrases: indices inside the phrases, topics in order and not overlapping,
 * a key part that leaves at least one word, accents spaced out. Returns null
 * when nothing usable is left — which sends the render to the fallback.
 */
export function validateMarkup(raw: unknown, chunks: SubtitleChunk[]): CaptionMarkup | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = chunks.length;
  const isIndex = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < max;

  const topics: CaptionMarkup['topics'] = [];
  let next = 0;
  for (const t of Array.isArray(r.topics) ? r.topics : []) {
    const { from, to, keyword } = (t ?? {}) as Record<string, unknown>;
    if (!isIndex(from, n) || !isIndex(to, n) || (to as number) < (from as number) || (from as number) < next) continue;
    if (typeof keyword !== 'string') continue;
    const word = keyword.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}%-]/gu, '') ?? '';
    if (!word || word.length > 24) continue;
    topics.push({ from: from as number, to: to as number, keyword: word });
    next = (to as number) + 1;
  }

  const rawKeys = Array.isArray(r.keyStart) ? r.keyStart : [];
  const keyStart = chunks.map((c, i) => {
    const k = rawKeys[i];
    return isIndex(k, c.words.length) ? (k as number) : defaultKeyStart(c);
  });

  const accents: CaptionMarkup['accents'] = [];
  let lastAt = -Infinity;
  for (const a of Array.isArray(r.accents) ? r.accents : []) {
    const { chunk, word } = (a ?? {}) as Record<string, unknown>;
    if (!isIndex(chunk, n) || !isIndex(word, chunks[chunk as number].words.length)) continue;
    const at = chunks[chunk as number].start;
    if (at - lastAt < ACCENT_GAP_SEC) continue;
    accents.push({ chunk: chunk as number, word: word as number });
    lastAt = at;
  }

  if (topics.length === 0) return null;
  return { topics, keyStart, accents };
}

/** The second half of the phrase is its key part — the plain reading of "lead-in, then point". */
function defaultKeyStart(chunk: SubtitleChunk): number {
  const n = chunk.words.length;
  return n <= 1 ? 0 : Math.floor(n / 2);
}

/**
 * The fallback, with no model: a topic every few phrases named by the
 * heuristic emphasis word, the second half of each phrase as its key, and
 * no handwritten accents — choosing the feeling is exactly what a heuristic
 * cannot do, so it does not pretend to.
 */
export function heuristicMarkup(chunks: SubtitleChunk[], phrasesPerTopic = 3): CaptionMarkup {
  const topics: CaptionMarkup['topics'] = [];
  for (let from = 0; from < chunks.length; from += phrasesPerTopic) {
    const to = Math.min(chunks.length - 1, from + phrasesPerTopic - 1);
    const words = chunks.slice(from, to + 1).flatMap((c) => c.words.map((w) => w.word));
    const i = pickEmphasis(words);
    if (i !== null) topics.push({ from, to, keyword: words[i].replace(/[^\p{L}\p{N}%-]/gu, '') });
  }
  return { topics, keyStart: chunks.map(defaultKeyStart), accents: [] };
}

export interface TopicLook {
  /** Fonts by family name — each needs its file in assets/fonts. */
  keywordFont: string;
  leadFont: string;
  accentFont: string;
  keywordColour: string;
  textColour: string;
  accentColour: string;
}

export const DEFAULT_TOPIC_LOOK: TopicLook = {
  keywordFont: 'Oswald',
  leadFont: 'Montserrat',
  accentFont: 'Caveat',
  keywordColour: '&H001C148C', // #8C141C burgundy
  textColour: '&H00DCE4EC', // #ECE4DC cream
  accentColour: '&H00FFFFFF',
};

export interface TopicMeasures {
  keyword: MeasureText;
  key: MeasureText;
}

/**
 * Every event for the three layers, for the whole clip. `style` is the
 * caption style already scaled to the frame: its fontSize is the key line's
 * size and its marginV where the caption block sits above the bottom.
 */
/** The key part is the big line: never more words than this, the rest is lead-in. */
export const MAX_KEY_WORDS = 3;

/** Phrases for this look are longer than the default captions: a lead-in plus a key part. */
export const TOPIC_CHUNK_OPTIONS = { minWords: 2, maxWords: 7, maxChars: 42, maxGapSec: 0.5, minDurationSec: 0.8 };

/** A phrase stays up until the next one starts, but no longer than this past its end. */
const HOLD_SEC = 0.8;

export interface TopicPlacement {
  /** Where the picture starts in the frame (0 when it fills it). */
  pictureTop: number;
  /**
   * No topic word before this time: a headline is on screen in the same
   * place until then. Infinity — a headline for the whole clip — means no
   * topic words at all; the form says so before the render.
   */
  hiddenUntil: number;
  /**
   * "Слово за человеком": where the top of the speaker is during each
   * keyword window (personMask.ts), in frame pixels, null for nobody there.
   * The word then sits on that line, wider than the head, so the head hides
   * only its lower part — behind a vertical close-up a word at the usual
   * height is covered whole.
   */
  personTops?: Array<number | null>;
}

/** Behind the speaker the word spans almost the frame, so it shows on both sides of the head. */
const BEHIND_WIDTH = 0.92;
/** …and may grow past the usual cap to get there. */
const BEHIND_SIZE_CAP = 4.5;
/** Oswald's capitals stand about three quarters of the font size tall. */
const CAP_HEIGHT = 0.75;

export function buildTopicEvents(
  chunks: SubtitleChunk[],
  markup: CaptionMarkup,
  style: SubtitleStyle,
  measures: TopicMeasures,
  look: TopicLook = DEFAULT_TOPIC_LOOK,
  placement: TopicPlacement = { pictureTop: 0, hiddenUntil: 0 }
): string[] {
  const layers = buildTopicLayers(chunks, markup, style, measures, look, placement);
  return [...layers.keywords, ...layers.captions];
}

export interface TopicLayers {
  /** The topic words alone — what "слово за человеком" draws behind the speaker. */
  keywords: string[];
  /** When each topic word is on screen, in seconds: the only frames that need a person mask. */
  keywordWindows: Array<{ start: number; end: number }>;
  /** Everything else: the two-tier caption and the handwritten accents. */
  captions: string[];
}

/** The same events as buildTopicEvents, with the topic words kept apart. */
export function buildTopicLayers(
  chunks: SubtitleChunk[],
  markup: CaptionMarkup,
  style: SubtitleStyle,
  measures: TopicMeasures,
  look: TopicLook = DEFAULT_TOPIC_LOOK,
  placement: TopicPlacement = { pictureTop: 0, hiddenUntil: 0 }
): TopicLayers {
  const W = style.playResX;
  const H = style.playResY;
  const cx = Math.round(W / 2);
  const keywords: string[] = [];
  const keywordWindows: TopicLayers['keywordWindows'] = [];
  const dialogue = (start: number, end: number, tags: string, text: string) =>
    end > start ? [`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Caption,,0,0,0,,{${tags}}${escapeAssText(text)}`] : [];

  // 1. Topic keywords. Held from the topic's first phrase to its last, and
  // never shorter than MIN_TOPIC_SEC, but cut at the next topic's start.
  // On the top of the picture, over the speaker's head — never in the bars
  // around a letterboxed one. Not pushed down to make room for a headline:
  // that lands it on the face; the headline and the topic word take turns
  // instead (hiddenUntil).
  const pictureHeight = Math.max(1, H - 2 * placement.pictureTop);
  const keywordSizeCap = Math.round(style.fontSize * 3.2);
  const keywordY = Math.round(Math.max(H * 0.22, placement.pictureTop + pictureHeight * 0.16));
  markup.topics.forEach((topic, i) => {
    const start = Math.max(chunks[topic.from].start, placement.hiddenUntil);
    const nextStart = markup.topics[i + 1] ? chunks[markup.topics[i + 1].from].start : Infinity;
    const end = Math.min(nextStart, Math.max(chunks[topic.to].end, start + MIN_TOPIC_SEC));
    const word = topic.keyword.toLocaleUpperCase('ru');
    const top = placement.personTops?.[keywordWindows.length];
    let size = fit(word, measures.keyword, W * 0.8, keywordSizeCap);
    let y = keywordY;
    if (top !== undefined && top !== null) {
      size = grow(word, measures.keyword, W * BEHIND_WIDTH, Math.round(style.fontSize * BEHIND_SIZE_CAP));
      // The middle of the letters on the top of the head: the upper half
      // stands clear, the lower half goes behind the hair. Never out of the
      // picture at the top.
      const half = Math.round((size * CAP_HEIGHT) / 2);
      y = Math.max(top, placement.pictureTop + half + Math.round(H * 0.02));
    }
    keywords.push(...dialogue(start, end, `\\an5\\pos(${cx},${y})\\fn${look.keywordFont}\\b1\\fs${size}\\c${look.keywordColour}\\bord0\\shad0`, word));
    if (end > start) keywordWindows.push({ start, end });
  });
  const captions: string[] = [];

  // 2. The two-tier caption, per phrase: the lead-in from the phrase's start,
  // the key part from the moment its first word is said.
  const keyY = H - style.marginV - Math.round(style.fontSize / 2);
  const leadSize = Math.max(20, Math.round(style.fontSize * 0.38));
  const leadY = keyY - Math.round(style.fontSize * 0.55) - Math.round(leadSize * 0.6);
  // Letter spacing for the small caps line, about a sixth of its size.
  const spacing = Math.round(leadSize * 0.17);
  chunks.forEach((chunk, ci) => {
    const until = Math.min(chunks[ci + 1]?.start ?? Infinity, chunk.end + HOLD_SEC);
    // Short and big: a key part longer than MAX_KEY_WORDS gives its first
    // words to the lead-in rather than shrinking to fit the width.
    const k = Math.max(Math.min(markup.keyStart[ci] ?? 0, chunk.words.length - 1), chunk.words.length - MAX_KEY_WORDS);
    const lead = chunk.words.slice(0, k).map((w) => w.word).join(' ').toLocaleUpperCase('ru');
    const key = chunk.words.slice(k).map((w) => w.word).join(' ').toLocaleUpperCase('ru');
    if (lead) {
      captions.push(...dialogue(chunk.start, until, `\\an5\\pos(${cx},${leadY})\\fn${look.leadFont}\\fs${leadSize}\\fsp${spacing}\\c${look.textColour}`, lead));
    }
    const keyAt = Math.max(chunk.start, chunk.words[k].start);
    const keySize = fit(key, measures.key, W * 0.9, style.fontSize);
    captions.push(...dialogue(keyAt, until, `\\an5\\pos(${cx},${keyY})\\fn${look.keywordFont}\\b1\\fs${keySize}\\c${look.textColour}`, key));
  });

  // 3. Handwritten accents: the word, tilted, just above the caption block
  // and a little into it, for as long as its phrase is up.
  const accentSize = Math.round(style.fontSize * 1.1);
  const accentY = leadY - Math.round(accentSize * 0.45);
  for (const a of markup.accents) {
    const chunk = chunks[a.chunk];
    const word = chunk.words[a.word].word.toLocaleLowerCase('ru');
    captions.push(...dialogue(chunk.words[a.word].start, chunk.end, `\\an5\\pos(${cx + Math.round(W * 0.12)},${accentY})\\fn${look.accentFont}\\fs${accentSize}\\frz8\\c${look.accentColour}\\bord0`, word));
  }
  return { keywords, keywordWindows, captions };
}

// The size at which the text is exactly `width` wide, but never above `cap`.
function grow(text: string, measure: MeasureText, width: number, cap: number): number {
  const at100 = measure(text, 100);
  if (at100 <= 0) return cap;
  return Math.max(1, Math.min(cap, Math.floor((100 * width) / at100)));
}

// Largest size at or below `preferred` that fits — never wider than the frame.
function fit(text: string, measure: MeasureText, maxWidth: number, preferred: number): number {
  const width = measure(text, preferred);
  if (width <= maxWidth || width <= 0) return preferred;
  return Math.max(1, Math.floor((preferred * maxWidth) / width));
}
