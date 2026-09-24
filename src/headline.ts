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

import { REFERENCE_FRAME, type FrameSize } from './aspect';
import { headlineColour, headlineFont, headlineSize } from './headlineStyles';

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
  /**
   * Where the band starts. Zero — the top of the frame — whenever the picture
   * fills everything below it, which is every vertical source. A letterboxed
   * one floats in the middle of the frame, and the band follows it down rather
   * than staying at the edge with nothing underneath.
   */
  bandTop: number;
}

export const DEFAULT_HEADLINE_STYLE: HeadlineStyle = {
  // No env override and no system lookup: the family comes from a file in
  // assets/fonts/ that ffmpeg is pointed at directly, so this name is one
  // libass is guaranteed to resolve rather than quietly replace.
  fontName: 'Montserrat',
  fontSize: 96,
  fontSizeSmall: 74,
  primaryColour: '&H00FFFFFF', // white
  playResX: 1080,
  playResY: 1920,
  bandHeight: HEADLINE_BAND_HEIGHT,
  bandTop: 0,
};

/**
 * The style for what a person picked in the three headline controls.
 *
 * The small size is derived rather than chosen: it is the step the builder
 * takes when the text needs a third line, and asking someone to nominate both
 * numbers would be asking them to solve a layout problem we can solve.
 */
export function headlineStyleFor(choice: {
  font?: string | null;
  size?: string | null;
  colour?: string | null;
}): HeadlineStyle {
  const fontSize = headlineSize(choice.size).fontSize;
  return {
    ...DEFAULT_HEADLINE_STYLE,
    fontName: headlineFont(choice.font).family,
    fontSize,
    fontSizeSmall: Math.round(fontSize * 0.78),
    primaryColour: headlineColour(choice.colour).colour,
  };
}

/**
 * The band's height in a frame of a given shape.
 *
 * Exported because two places need the same answer and they are in different
 * files: this module draws the text inside the band, and ffmpeg.ts shrinks the
 * picture to leave the band empty. Deriving it twice from the same formula is
 * how they drift, and the symptom would be a headline over the speaker's face
 * in one format only — visible nowhere except in a finished render.
 */
export function bandHeightForFrame(frame: FrameSize): number {
  return Math.round(HEADLINE_BAND_HEIGHT * (frame.height / REFERENCE_FRAME.height));
}

export interface BandLayout {
  /** Height the picture gives up so the band has somewhere to go. */
  reserve: number;
  /** Where the picture's top edge lands in the finished frame. */
  pictureTop: number;
  /** Where the band starts — directly above the picture, wherever that is. */
  bandTop: number;
}

/**
 * Where the headline band goes, and what the picture pays for it.
 *
 * Two things a client got wrong in turn, both of which look the same from the
 * outside — a title stranded at the top of the frame with the video far below
 * it — and neither of which is visible anywhere but in a finished render.
 *
 * The first is how much room to take. A source that does not share the frame's
 * shape is letterboxed already, and that black is room the headline can simply
 * use; taking the band on top of it counts the same emptiness twice. Their clip
 * was 3840x2160 in a vertical frame: 656px of black above it, a band wanting
 * 420, and 420 more reserved anyway. The reserve here is only the shortfall,
 * derived rather than tuned — the picture ends up centred in what remains, so
 * its top edge lands at (frameHeight + reserve - pictureHeight) / 2, and this
 * is the smallest reserve that keeps that clear of the band.
 *
 * The second is where to put it. Reserving nothing leaves the picture floating
 * in the middle of the frame, and a band still pinned to the top edge has
 * nothing underneath it — the gap moves from below the headline to above it and
 * the complaint survives the fix. So the band sits against the picture. For a
 * source that fills the frame that is the top edge anyway, which is why this
 * changes nothing for anything shot on a phone.
 */
export function bandLayoutFor(frame: FrameSize, source: FrameSize | null, bandHeight: number): BandLayout {
  if (bandHeight <= 0) return { reserve: 0, pictureTop: 0, bandTop: 0 };
  // Without the source's shape there is no letterbox to measure, so the band
  // takes its own room at the top of the frame — what every render did before
  // this, and the safe answer when the probe could not read the dimensions.
  if (!source || !source.width || !source.height) {
    return { reserve: bandHeight, pictureTop: bandHeight, bandTop: 0 };
  }

  const fittedToWidth = (frame.width * source.height) / source.width;
  const reserve = Math.round(
    Math.min(bandHeight, Math.max(0, 2 * bandHeight - frame.height + fittedToWidth))
  );
  const fitted = Math.min(frame.height - reserve, fittedToWidth);
  const pictureTop = Math.round((frame.height + reserve - fitted) / 2);
  // The band sits against the picture rather than against the frame. Pinning
  // it to the top instead is what left a client's title stranded at the very
  // edge with the video floating in the middle of the frame — the gap the
  // reserve fix took out from under the headline simply reappeared above it.
  return { reserve, pictureTop, bandTop: Math.max(0, pictureTop - bandHeight) };
}

/**
 * The headline remapped onto another frame shape.
 *
 * Every number follows the HEIGHT here, unlike captions, where the text scales
 * with the width. The band and its type are not independent choices: the words
 * have to fit inside the strip, and the strip is a fraction of the height.
 * Scaling the font by width would ask a 171px headline to fit a 236px band in
 * a landscape frame, three lines at a time.
 */
export function scaleHeadlineToFrame(style: HeadlineStyle, frame: FrameSize): HeadlineStyle {
  const scale = frame.height / REFERENCE_FRAME.height;
  return {
    ...style,
    fontSize: Math.round(style.fontSize * scale),
    fontSizeSmall: Math.round(style.fontSizeSmall * scale),
    bandHeight: bandHeightForFrame(frame),
    playResX: frame.width,
    playResY: frame.height,
  };
}

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
  bandBottom: number = HEADLINE_BAND_HEIGHT
): T {
  if (!headline || !sanitizeHeadline(headline)) return style;
  // 7, 8 and 9 are the top row of the numpad layout.
  if (style.alignment < 7 || style.alignment > 9) return style;
  // Measured from where the band ENDS, not from how tall it is. Those are the
  // same number only while the band starts at the frame's top edge, which is
  // no longer true of a letterboxed source — and using the height there would
  // put the captions back inside the band.
  const clearance = bandBottom + 60;
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
  const textEvent = event(`{\\an5\\pos(${Math.round(style.playResX / 2)},${Math.round(style.bandTop + style.bandHeight / 2)})}${lines.join('\\N')}`);

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    textEvent,
  ].join('\n');

  return `${header}\n\n${styles}\n\n${events}\n`;
}
