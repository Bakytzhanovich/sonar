import { describe, it, expect } from 'vitest';
import { aspectRatioFor, ASPECT_RATIOS, isAspectRatioId, REFERENCE_FRAME } from '../src/aspect';
import { DEFAULT_SUBTITLE_STYLE, scaleStyleToFrame } from '../src/subtitles';
import { bandHeightForFrame, DEFAULT_HEADLINE_STYLE, scaleHeadlineToFrame } from '../src/headline';
import { styleForPreset } from '../src/subtitlePresets';
import { applyPosition } from '../src/subtitlePositions';

// Every number in a caption or headline style is written against 1080×1920 and
// scaled from there. Nothing about getting that wrong is loud: libass sizes
// text relative to PlayRes and reports nothing, so a bad scale produces a
// finished video with the wrong typography and a clean log. These tests are
// the only place it is cheap to catch.

describe('aspect ratio catalogue', () => {
  it('falls back to vertical for an id that is not offered', () => {
    // Rows written before the column existed, and hand-made requests, both
    // land here — and vertical is what they meant.
    expect(aspectRatioFor(undefined).id).toBe('9_16');
    expect(aspectRatioFor(null).id).toBe('9_16');
    expect(aspectRatioFor('4_5').id).toBe('9_16');
  });

  it('offers only ids it can actually resolve', () => {
    for (const ratio of ASPECT_RATIOS) {
      expect(isAspectRatioId(ratio.id)).toBe(true);
      expect(aspectRatioFor(ratio.id)).toBe(ratio);
    }
    expect(isAspectRatioId('16:9')).toBe(false);
  });

  it('keeps the vertical frame identical to the reference', () => {
    // The format became a choice; what it renders when nobody chooses must not
    // have moved.
    expect(aspectRatioFor('9_16')).toMatchObject(REFERENCE_FRAME);
  });
});

describe('scaleStyleToFrame', () => {
  it('leaves the vertical frame untouched', () => {
    const scaled = scaleStyleToFrame(DEFAULT_SUBTITLE_STYLE, aspectRatioFor('9_16'));
    expect(scaled).toEqual(DEFAULT_SUBTITLE_STYLE);
  });

  it('keeps captions the same size in a square, which is as wide as a vertical', () => {
    // The visible regression this guards: scaling text by height instead would
    // halve it here, and a square posted next to a vertical one at the same
    // display width would have captions half the size for no stated reason.
    const square = scaleStyleToFrame(DEFAULT_SUBTITLE_STYLE, aspectRatioFor('1_1'));
    expect(square.fontSize).toBe(DEFAULT_SUBTITLE_STYLE.fontSize);
    expect(square.outline).toBe(DEFAULT_SUBTITLE_STYLE.outline);
    expect(square.playResX).toBe(1080);
    expect(square.playResY).toBe(1080);
  });

  it('grows text with the width and margins with the height in a landscape frame', () => {
    const landscape = scaleStyleToFrame(DEFAULT_SUBTITLE_STYLE, aspectRatioFor('16_9'));
    // 1920/1080 wider, so the text holds the same share of the width and comes
    // out the same size on a screen showing both at one width.
    expect(landscape.fontSize).toBe(Math.round(DEFAULT_SUBTITLE_STYLE.fontSize * (1920 / 1080)));
    expect(landscape.outline).toBeCloseTo(DEFAULT_SUBTITLE_STYLE.outline * (1920 / 1080), 1);
    // The margin is a vertical distance, so it follows the height — scaled by
    // width it would move the captions towards the middle of the frame.
    expect(landscape.marginV).toBe(Math.round(DEFAULT_SUBTITLE_STYLE.marginV * (1080 / 1920)));
    expect(landscape.playResX).toBe(1920);
    expect(landscape.playResY).toBe(1080);
  });

  it('keeps the bottom position clear of the platform UI it was measured against', () => {
    // 340 of 1920 is the lower fifth Reels and Shorts reserve. Whatever the
    // frame, the margin has to stay that same fraction of the height — scaled
    // by width, 340 would become 605 of a 1080-high frame and put the captions
    // above the middle.
    const bottom = applyPosition(styleForPreset('classic'), 'bottom');
    const landscape = scaleStyleToFrame(bottom, aspectRatioFor('16_9'));
    expect(landscape.marginV / landscape.playResY).toBeCloseTo(bottom.marginV / 1920, 3);
    expect(landscape.marginV).toBeLessThan(landscape.playResY / 2);
  });
});

describe('scaleHeadlineToFrame', () => {
  it('leaves the vertical frame untouched', () => {
    const scaled = scaleHeadlineToFrame(DEFAULT_HEADLINE_STYLE, aspectRatioFor('9_16'));
    expect(scaled).toEqual(DEFAULT_HEADLINE_STYLE);
  });

  it('keeps the band the same share of the height in every frame', () => {
    for (const ratio of ASPECT_RATIOS) {
      expect(bandHeightForFrame(ratio) / ratio.height).toBeCloseTo(420 / 1920, 3);
    }
  });

  it('shrinks the headline type with its band, not with the width', () => {
    // The band is a slice of the height, and the words have to fit inside it.
    // Scaling the font by width in a landscape frame would ask a 171px
    // headline to fit a 236px band three lines at a time.
    const landscape = scaleHeadlineToFrame(DEFAULT_HEADLINE_STYLE, aspectRatioFor('16_9'));
    expect(landscape.bandHeight).toBe(236);
    expect(landscape.fontSize).toBe(54);
    expect(landscape.fontSize * 3).toBeLessThan(landscape.bandHeight);
    expect(landscape.playResX).toBe(1920);
    expect(landscape.playResY).toBe(1080);
  });

  it('agrees with the band the filter graph reserves', () => {
    // Two files compute this: headline.ts draws inside the band, ffmpeg.ts
    // leaves it empty. If they ever disagree the headline lands on the
    // speaker's face, and only a finished render shows it.
    for (const ratio of ASPECT_RATIOS) {
      expect(scaleHeadlineToFrame(DEFAULT_HEADLINE_STYLE, ratio).bandHeight).toBe(bandHeightForFrame(ratio));
    }
  });
});
