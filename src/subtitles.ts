import type { KeepSegment, TranscriptWord } from './smartCut';

// Module 8, Level 3 — burned-in "Hormozi style" captions: two to four words on
// screen at a time, the word currently being spoken highlighted.
//
// Rendered as an .ass (Advanced SubStation Alpha) file that ffmpeg's `ass`
// filter burns into the frame. The alternative — drawing text per frame — is
// what MoviePy does and it is one to two orders of magnitude slower: libass
// rasterises a caption once and composites it, where a per-frame text pass
// re-renders the same glyphs 30 times a second.

export interface SubtitleChunk {
  words: TranscriptWord[];
  start: number;
  end: number;
}

export interface SubtitleStyle {
  fontName: string;
  fontSize: number;
  // ASS colours are &HAABBGGRR — alpha first, then BLUE-GREEN-RED, the
  // reverse of the RRGGBB everyone expects. Getting this backwards is silent:
  // you just get the wrong colour.
  primaryColour: string;
  highlightColour: string;
  outlineColour: string;
  outline: number;
  shadow: number;
  // libass alignment is numpad-shaped: 1-3 bottom row, 4-6 middle row, 7-9
  // top row. 5 is dead centre, 2 is bottom centre.
  alignment: number;
  marginV: number;
  playResX: number;
  playResY: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  // The font must actually exist in the rendering environment. libass does not
  // error on a missing family — it silently substitutes whatever it can find,
  // so a render "succeeds" with completely different typography and nothing in
  // the logs says so (verified: rendering with Montserrat absent produces no
  // warning at all). The Dockerfile installs it and fails the build if it is
  // missing; this env override exists for a machine where a different family
  // is available.
  fontName: process.env.SUBTITLE_FONT ?? 'Montserrat',
  fontSize: 64,
  primaryColour: '&H00FFFFFF',   // white
  highlightColour: '&H0000FFFF', // yellow
  outlineColour: '&H00000000',   // black
  outline: 3,
  shadow: 2,
  alignment: 5,
  marginV: 60,
  // PlayRes must match the OUTPUT resolution, not the source: libass scales
  // every size and margin relative to it, so a mismatch makes a 64px font come
  // out at some other size entirely.
  playResX: 1080,
  playResY: 1920,
};

export interface ChunkOptions {
  minWords: number;
  maxWords: number;
  // A caption has to be readable in a fraction of a second, which is a limit
  // on characters, not on words — "я не понимаю" and "экспериментировать"
  // are both one line's worth but very different widths.
  maxChars: number;
  // A pause this long inside a chunk means the speaker moved on; breaking
  // there keeps the caption in step with the delivery instead of holding
  // stale words on screen.
  maxGapSec: number;
  // Minimum time a chunk stays up, so a fast three-word burst does not flash
  // past unreadably.
  minDurationSec: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  minWords: 2,
  maxWords: 4,
  maxChars: 25,
  maxGapSec: 0.4,
  minDurationSec: 0.4,
};

// ---- Timeline remapping --------------------------------------------------

// THE critical step, and the one that is invisible until the whole thing is
// watched: Whisper's timestamps are in the SOURCE timeline, but Smart Cut has
// already removed pieces of it. Burning captions at their original times would
// put them progressively further out of sync — by exactly the amount of
// silence removed before them, which is usually seconds.
//
// So every word is projected onto the output timeline: its time minus all
// removed time that precedes it. Words that fell entirely inside a removed
// region (fillers, and anything inside a cut pause) have no place in the
// output and are dropped.
export function remapWordsToOutputTimeline(words: TranscriptWord[], segments: KeepSegment[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let elapsed = 0;

  for (const segment of segments) {
    for (const word of words) {
      // Overlap of the word with this kept segment. A word straddling a cut
      // boundary is clipped to the part that survived rather than dropped —
      // the syllable is still audible, so the caption should still show it.
      const start = Math.max(word.start, segment.start);
      const end = Math.min(word.end, segment.end);
      if (end <= start) continue;
      out.push({ word: word.word, start: elapsed + (start - segment.start), end: elapsed + (end - segment.start) });
    }
    elapsed += segment.end - segment.start;
  }

  // Segments are processed in order and each contributes words in order, so
  // the result is already sorted; sorting again would be a no-op that hides a
  // bug if that ever stops being true.
  return out;
}

// ---- Chunking ------------------------------------------------------------

function displayLength(words: TranscriptWord[]): number {
  return words.reduce((sum, w) => sum + w.word.trim().length, 0) + Math.max(0, words.length - 1);
}

// Ends a sentence — a natural place to break even when the chunk is short.
function endsSentence(word: string): boolean {
  return /[.!?…]$/.test(word.trim());
}

export function chunkWords(words: TranscriptWord[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): SubtitleChunk[] {
  const chunks: SubtitleChunk[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
    current = [];
  };

  for (const word of words) {
    if (!word.word.trim()) continue;

    const gapTooLong = current.length > 0 && word.start - current[current.length - 1].end > options.maxGapSec;
    const wouldOverflow = current.length > 0 && displayLength([...current, word]) > options.maxChars;
    // minWords is a preference, not a rule: a chunk is allowed to fall below
    // it when the line would otherwise be unreadably long, or when the speaker
    // paused. Enforcing it strictly is how captions end up running off-screen.
    if (current.length >= options.maxWords || gapTooLong || wouldOverflow) flush();

    current.push(word);

    if (current.length >= options.minWords && endsSentence(word.word)) flush();
  }
  flush();

  return extendShortChunks(chunks, options.minDurationSec);
}

// Holds a too-brief chunk on screen longer, but never past the next chunk's
// start — overlapping events would show two captions at once.
function extendShortChunks(chunks: SubtitleChunk[], minDurationSec: number): SubtitleChunk[] {
  return chunks.map((chunk, i) => {
    if (chunk.end - chunk.start >= minDurationSec) return chunk;
    const nextStart = chunks[i + 1]?.start ?? Infinity;
    return { ...chunk, end: Math.min(chunk.start + minDurationSec, nextStart) };
  });
}

// ---- .ass generation -----------------------------------------------------

// ASS time format is H:MM:SS.cc — one digit of hours, exactly two of
// centiseconds. Anything else is silently ignored by libass, which shows up as
// captions that never appear.
export function formatAssTime(seconds: number): string {
  // Rounded to whole centiseconds FIRST, then decomposed. Taking the
  // fractional part of a float and flooring it instead loses a centisecond to
  // representation error (3723.04 - 3723 is 0.0399999..., which floors to 3),
  // so every timestamp drifts a hundredth early — harmless alone, visible as
  // creeping desync across a few hundred captions.
  const totalCs = Math.round(Math.max(0, seconds) * 100);
  const cs = totalCs % 100;
  const totalSeconds = (totalCs - cs) / 100;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ASS has two pieces of in-band syntax that a transcript can carry by
// accident — or that a caller could plant deliberately, since this text
// ultimately comes from a user-supplied video:
//   {...}  an override block. Stripping only the braces is not enough: the
//          contents are tag syntax too, and '{\\an8}вот' would otherwise leave
//          a literal '\\an8' in the caption.
//   \\      the escape character (\\N is a hard line break, \\h a hard space).
// Both are removed outright rather than escaped; neither has any legitimate
// meaning inside spoken words.
function escapeAssText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    // Captions here are single-line by design (WrapStyle 2), so a stray
    // newline becomes a space rather than an ASS hard break.
    .replace(/\r?\n/g, ' ')
    .trim();
}

function styleBlock(style: SubtitleStyle): string {
  // Bold=1 (-1 in the spec means "on"; libass accepts 1), BorderStyle=1 is
  // outline+shadow rather than the opaque box, ScaleX/Y 100, no rotation.
  return [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${style.fontName},${style.fontSize},${style.primaryColour},${style.highlightColour},${style.outlineColour},&H00000000,-1,0,0,0,100,100,0,0,1,${style.outline},${style.shadow},${style.alignment},60,60,${style.marginV},1`,
  ].join('\n');
}

export function buildAssFile(chunks: SubtitleChunk[], style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // WrapStyle 2 = no automatic wrapping. Chunks are already short enough,
    // and letting libass wrap would silently turn a 4-word caption into two
    // lines of two, breaking the centred single-line look.
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
  ].join('\n');

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...chunks.flatMap((chunk) => buildChunkEvents(chunk, style)),
  ].join('\n');

  return `${header}\n\n${styleBlock(style)}\n\n${events}\n`;
}

// One Dialogue event per word, each showing the whole chunk with a different
// word highlighted.
//
// The alternative is a single event using karaoke tags (\k), which is more
// compact — but \k expresses the highlight as a Secondary->Primary colour
// transition, and exactly how that is interpreted varies between renderers.
// An explicit colour override per word renders identically everywhere and,
// unlike \k, leaves room to animate the active word later.
function buildChunkEvents(chunk: SubtitleChunk, style: SubtitleStyle): string[] {
  return chunk.words.map((active, index) => {
    // Each event runs until the next word begins (not until the current word
    // ends), so the caption stays on screen continuously through the small
    // gaps between words instead of flickering off and on.
    const start = index === 0 ? chunk.start : active.start;
    const end = index === chunk.words.length - 1 ? chunk.end : chunk.words[index + 1].start;
    if (end <= start) return '';

    const text = chunk.words
      .map((word, i) => {
        const escaped = escapeAssText(word.word);
        // {\c...}word{\c} — override the colour, then reset to the style's
        // own. Without the trailing reset the highlight leaks into every
        // following word on the line.
        return i === index ? `{\\c${style.highlightColour}}${escaped}{\\c}` : escaped;
      })
      .join(' ');

    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Caption,,0,0,0,,${text}`;
  }).filter(Boolean);
}

// Convenience wrapper: the three steps in the order the pipeline needs them.
export function buildSubtitlesForPlan(
  words: TranscriptWord[],
  segments: KeepSegment[],
  style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE,
  chunkOptions: ChunkOptions = DEFAULT_CHUNK_OPTIONS
): { ass: string; chunks: SubtitleChunk[] } {
  const chunks = chunkWords(remapWordsToOutputTimeline(words, segments), chunkOptions);
  return { ass: buildAssFile(chunks, style), chunks };
}
