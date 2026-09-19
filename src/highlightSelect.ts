import type { TranscriptWord } from './smartCut';

// Choosing which minute of a long recording is worth posting.
//
// Smart Cut removes dead air. It has no opinion about what was said, so a
// ten-minute talk comes back as an eight-minute talk — tighter, and still
// nobody watches it. What a blogger actually wants from ten minutes is the
// sixty seconds that were good.
//
// That question is about meaning, which is the one thing a language model is
// better at than a rule. It cannot be asked of the audio, though: the model
// gets the transcript, and the transcript carries times, so an answer about
// text can be turned back into an answer about video.
//
// Everything in this file is the part that can be wrong in a way we can
// check — building the question and validating the answer. The call itself
// lives elsewhere, so this can be tested without a network or a key.

/** A stretch of speech the model can refer to by number. */
export interface Sentence {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface HighlightSpan {
  start: number;
  end: number;
}

/**
 * Groups words into sentence-sized lines for the model to choose between.
 *
 * Word-by-word would be both unreadable and enormous — a ten-minute talk is
 * some 1500 words, and the model would spend its attention on reassembling
 * them instead of judging them. Splitting on sentence-ending punctuation and
 * on long pauses gives units a person would recognise as thoughts.
 */
export function groupIntoSentences(words: TranscriptWord[], maxPauseSec = 0.8): Sentence[] {
  const sentences: Sentence[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    sentences.push({
      index: sentences.length,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.word).join(' '),
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    current.push(words[i]);
    const endsSentence = /[.!?…]$/.test(words[i].word.trim());
    const next = words[i + 1];
    // A long gap ends a thought as surely as a full stop, and speech
    // transcripts are short of full stops.
    const longPause = next !== undefined && next.start - words[i].end >= maxPauseSec;
    if (endsSentence || longPause) flush();
  }
  flush();

  return sentences;
}

/**
 * The transcript as the model sees it: numbered lines with their timing.
 *
 * Times are included so the model can judge length itself rather than being
 * asked for a sentence range and having the length discovered afterwards —
 * it is being asked for something that fits, not just something good.
 */
export function buildHighlightPrompt(sentences: Sentence[], targetSec: number): string {
  const lines = sentences
    .map((s) => `[${s.index}] ${s.start.toFixed(1)}–${s.end.toFixed(1)}s: ${s.text}`)
    .join('\n');

  return [
    `Ниже расшифровка видео, разбитая на реплики с таймкодами.`,
    `Выбери ОДИН непрерывный фрагмент длиной примерно ${targetSec} секунд, который лучше всего работает как самостоятельный короткий ролик.`,
    ``,
    `Что делает фрагмент хорошим:`,
    `— начинается с сильной или интригующей фразы, а не с середины мысли;`,
    `— содержит законченную мысль, у которой есть конец;`,
    `— понятен тому, кто не видел остального видео.`,
    ``,
    `Ответь строго JSON: {"from": <номер первой реплики>, "to": <номер последней>, "why": "<одна фраза по-русски>"}`,
    `Никакого текста вокруг JSON.`,
    ``,
    lines,
  ].join('\n');
}

export type HighlightResult =
  | { ok: true; span: HighlightSpan; why: string }
  | { ok: false; reason: 'unparseable' | 'out_of_range' | 'empty' | 'too_far_from_target' };

/**
 * Turns the model's answer into a span, or refuses it.
 *
 * Refusing matters more than choosing here. The caller falls back to editing
 * the whole recording, which is what the product did before this existed —
 * a worse result, but a correct one. A hallucinated range would instead cut
 * a client's video at times taken from nowhere, and look deliberate.
 *
 * `tolerance` is generous on purpose: sentences do not divide evenly into
 * sixty seconds, and rejecting a good 48-second answer to a 60-second
 * request would throw away the thing we asked for over arithmetic.
 */
export function resolveHighlight(
  raw: string,
  sentences: Sentence[],
  targetSec: number,
  tolerance = 0.5
): HighlightResult {
  if (sentences.length === 0) return { ok: false, reason: 'empty' };

  let parsed: { from?: unknown; to?: unknown; why?: unknown };
  try {
    // Models wrap JSON in prose and fences however they are asked not to.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, reason: 'unparseable' };
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  const from = Number(parsed.from);
  const to = Number(parsed.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, reason: 'unparseable' };
  if (from < 0 || to >= sentences.length || to < from) return { ok: false, reason: 'out_of_range' };

  const span = { start: sentences[from].start, end: sentences[to].end };
  const length = span.end - span.start;
  if (length <= 0) return { ok: false, reason: 'empty' };

  // A "60 second" answer that is four minutes long is not an answer to the
  // question asked, whatever its literary merit.
  const ratio = length / targetSec;
  if (ratio > 1 + tolerance || ratio < 1 - tolerance) return { ok: false, reason: 'too_far_from_target' };

  const why = typeof parsed.why === 'string' ? parsed.why.trim().slice(0, 200) : '';
  return { ok: true, span, why };
}

/** The words inside the chosen span, with their times left alone. */
export function wordsInSpan(words: TranscriptWord[], span: HighlightSpan): TranscriptWord[] {
  return words.filter((w) => w.start >= span.start && w.end <= span.end);
}
