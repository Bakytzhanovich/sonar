// The shape of the finished frame.
//
// Level 3 rendered 1080×1920 and nothing else — right for Reels, TikTok and
// Shorts, wrong for the square a blogger posts to the feed and for the
// landscape cut that goes to YouTube.
//
// What this does NOT do is reframe. The picture is fitted with bars rather
// than cropped (see the scale/pad pair in ffmpeg.ts), so choosing 9:16 for a
// horizontal source still letterboxes it; choosing 16:9 is what keeps that
// source edge to edge. Cropping a wide shot down to a tall one without losing
// the speaker needs subject tracking, which is a separate piece of work.
//
// Every style number in subtitles.ts and headline.ts is written against
// REFERENCE_FRAME and scaled from it — see scaleStyleToFrame and
// scaleHeadlineToFrame for which numbers follow the width, which follow the
// height, and why they differ.

export interface FrameSize {
  width: number;
  height: number;
}

export type AspectRatioId = '9_16' | '1_1' | '16_9';

export interface AspectRatio extends FrameSize {
  id: AspectRatioId;
  label: string;
  description: string;
}

/** The frame every hard-coded size in the render was chosen against. */
export const REFERENCE_FRAME: FrameSize = { width: 1080, height: 1920 };

const VERTICAL: AspectRatio = {
  id: '9_16',
  label: '9:16 — вертикальное',
  description: 'Reels, TikTok, Shorts',
  width: 1080,
  height: 1920,
};

const SQUARE: AspectRatio = {
  id: '1_1',
  label: '1:1 — квадрат',
  description: 'Пост в ленте',
  width: 1080,
  height: 1080,
};

const LANDSCAPE: AspectRatio = {
  id: '16_9',
  label: '16:9 — горизонтальное',
  description: 'YouTube, плеер на сайте',
  // 1920 wide rather than 1080: the height is what a landscape frame has
  // little of, and cutting it to 607 to keep the width at 1080 would throw
  // away half the vertical resolution of a source that almost certainly has
  // 1080 of it.
  width: 1920,
  height: 1080,
};

export const ASPECT_RATIOS: AspectRatio[] = [VERTICAL, SQUARE, LANDSCAPE];

export const DEFAULT_ASPECT_RATIO: AspectRatioId = VERTICAL.id;

export function aspectRatioFor(id: string | null | undefined): AspectRatio {
  // An unknown id reaches here only from a row written before this column
  // existed or from a hand-made request, and vertical is what those meant.
  return ASPECT_RATIOS.find((ratio) => ratio.id === id) ?? VERTICAL;
}

export function isAspectRatioId(value: unknown): value is AspectRatioId {
  return typeof value === 'string' && ASPECT_RATIOS.some((ratio) => ratio.id === value);
}
