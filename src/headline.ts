// A typed headline in a band above the video — the "плашка" every second
// Reels opens with.
//
// Its own .ass file rather than extra events inside the caption one, for two
// reasons. A headline has to show when captions are switched off, and the two
// answer to different things: captions follow the speech and are regenerated
// whenever the cut changes, the headline is a fixed string somebody typed.
// ffmpeg chains ass filters happily, so this costs nothing at render time.
//
// The band is reserved, not borrowed. A 16:9 source letterboxed into 9:16
// already has black above it and the text would fit — but a clip shot
// vertically on a phone has no bars at all, and the headline would land on the
// speaker's face. ffmpeg.ts shrinks the picture to make room whenever there is
// a headline to place.

/** How much of the 1920-high frame the band takes. */
export const HEADLINE_BAND_HEIGHT = 420;

export interface HeadlineStyle {
  fontName: string;
  /** Used when the text fits in one or two lines. */
  fontSize: number;
  /** Dropped to this on a third line, so a long headline still fits the band. */
  fontSizeSmall: number;
  /** ASS colours are &HAABBGGRR — alpha, then BLUE-GREEN-RED. */
  primaryColour: string;
  playResX: number;
  playResY: number;
  bandHeight: number;
}

export const DEFAULT_HEADLINE_STYLE: HeadlineStyle = {
  // Same family as the captions, and the same caveat: libass substitutes a
  // missing family silently, so the render "succeeds" with the wrong
  // typography and nothing says so. The Dockerfile installs Montserrat.
  fontName: process.env.SUBTITLE_FONT ?? 'Montserrat',
  fontSize: 96,
  fontSizeSmall: 74,
  primaryColour: '&H00FFFFFF', // white
  playResX: 1080,
  playResY: 1920,
  bandHeight: HEADLINE_BAND_HEIGHT,
};

/**
 * Longest headline accepted, and it is deliberately what fits rather than a
 * round number: three lines of MAX_CHARS_PER_LINE.
 *
 * The limit belongs at the keyboard, not at the renderer. An earlier version
 * wrapped freely and dropped whatever ran past the third line, so a headline
 * came back a word short with nothing saying why — the writer had to notice
 * their own missing word in a finished video. Capping the input means the
 * person sees the boundary while they are still typing.
 */
export const HEADLINE_MAX_CHARS = 48;

/**
 * Characters per line before wrapping.
 *
 * Counted rather than measured, because measuring means font metrics we do not
 * have here — the same approximation the caption chunker already makes. Set
 * conservatively: an over-long line runs past the frame edge and is simply
 * lost, while an early break just looks like a deliberate two-liner.
 */
const MAX_CHARS_PER_LINE = 16;
const MAX_LINES = 3;

/**
 * Greedy word wrap. A single word longer than the limit gets its own line
 * rather than being cut — a hyphenated fragment of a Russian word reads as a
 * bug, and an over-wide line is the lesser of the two.
 */
function greedyWrap(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Wraps, then evens the lines out.
 *
 * Greedy alone packs the first line full and leaves the last one with whatever
 * is left, which is how "КАК Я ПОДНЯЛ 2 / МЛН" happens — a line break through
 * a number and its unit. Narrowing the width as far as it goes without adding
 * a line redistributes the words instead, and the result reads as a headline
 * somebody set rather than as text that ran out of room.
 */
export function wrapHeadline(text: string, maxChars: number = MAX_CHARS_PER_LINE): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  let lines = greedyWrap(words, maxChars);
  for (let width = maxChars - 1; width >= 4; width--) {
    const candidate = greedyWrap(words, width);
    if (candidate.length > lines.length) break;
    lines = candidate;
  }
  // The input is capped at three lines' worth, so this only ever trims a
  // pathological case — a single word longer than the whole band.
  return lines.slice(0, MAX_LINES);
}

/**
 * ASS override blocks are delimited by braces and backslashes, so a headline
 * containing either would break out of its own event and could set arbitrary
 * render tags. Stripped rather than escaped: the format has no escape for
 * them, and no headline needs a brace.
 */
export function sanitizeHeadline(text: string): string {
  return text
    .replace(/[{}\\]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, HEADLINE_MAX_CHARS);
}

// One event, held for the whole clip. An explicit end far past any accepted
// source is simpler than threading the duration down here, and a headline that
// outlives the video by hours is never seen.
function event(text: string): string {
  return `Dialogue: 0,0:00:00.00,9:59:59.99,Headline,,0,0,0,,${text}`;
}

/**
 * Pushes top-aligned captions below the headline band.
 *
 * A caption's vertical margin is measured from the frame edge, and with a
 * headline that edge is the band. Left alone, "субтитры сверху" plus a
 * headline puts both in the same strip — legible in neither case, and only
 * discovered once the render is watched. Any other alignment is measured from
 * somewhere the band does not reach, so it is returned untouched.
 */
export function clearOfHeadline<T extends { alignment: number; marginV: number }>(
  style: T,
  headline: string | null | undefined,
  bandHeight: number = HEADLINE_BAND_HEIGHT
): T {
  if (!headline || !sanitizeHeadline(headline)) return style;
  // 7, 8 and 9 are the top row of the numpad layout.
  if (style.alignment < 7 || style.alignment > 9) return style;
  const clearance = bandHeight + 60;
  return style.marginV >= clearance ? style : { ...style, marginV: clearance };
}

/**
 * Builds the .ass that draws the headline band's contents.
 *
 * Returns null for an empty headline — the caller then leaves the band out of
 * the filter graph entirely rather than reserving space for nothing.
 */
export function buildHeadlineAss(rawText: string, style: HeadlineStyle = DEFAULT_HEADLINE_STYLE): string | null {
  const text = sanitizeHeadline(rawText);
  if (!text) return null;

  const lines = wrapHeadline(text);
  if (lines.length === 0) return null;
  const fontSize = lines.length >= 3 ? style.fontSizeSmall : style.fontSize;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Wrapping is done above, in words we can count, and balanced there too
    // — libass would break lines wherever they happened to run out of room.
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
  ].join('\n');

  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // No outline: the band behind the text is already solid black, and an
    // outline over it only thickens the letterforms.
    `Style: Headline,${style.fontName},${fontSize},${style.primaryColour},${style.primaryColour},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1`,
  ].join('\n');

  // \an5 centres on \pos, which is the middle of the band — so one line and
  // three lines are both centred in it rather than growing downwards.
  const textEvent = event(`{\\an5\\pos(${Math.round(style.playResX / 2)},${Math.round(style.bandHeight / 2)})}${lines.join('\\N')}`);

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    textEvent,
  ].join('\n');

  return `${header}\n\n${styles}\n\n${events}\n`;
}
