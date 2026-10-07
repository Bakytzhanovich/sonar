import { describe, it, expect } from 'vitest';
import { aspectRatioFor, ASPECT_RATIOS, isAspectRatioId, REFERENCE_FRAME } from '../src/aspect';
import { DEFAULT_SUBTITLE_STYLE, scaleStyleToFrame } from '../src/subtitles';
import { bandHeightForFrame, bandLayoutFor, clearOfHeadline, DEFAULT_HEADLINE_STYLE, HEADLINE_SAFE_TOP, scaleHeadlineToFrame } from '../src/headline';
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
    // The margin clears the lower fifth Reels and Shorts reserve — 384 of
    // 1920. Whatever the frame, it has to stay the same FRACTION of the
    // height: scaled by width instead, it would grow on a wider frame and
    // shrink on a narrower one for no reason tied to where the platform UI
    // actually sits.
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

  it('puts the band in the black above a letterboxed picture, right against it', () => {
    // A 3840x2160 clip in a vertical frame sits 1080x608 with 656px of black
    // above it — room for the 420px band. Pinned to the frame's edge instead,
    // the title was stranded with the video floating far below it.
    const frame = aspectRatioFor('9_16');
    const band = bandHeightForFrame(frame);
    const layout = bandLayoutFor(frame, { width: 3840, height: 2160 }, band);

    expect(layout.bandTop).toBeGreaterThan(0);
    expect(layout.bandTop + band).toBe(layout.pictureTop);
  });

  it('lays the band over a picture that fills the frame instead of shrinking it', () => {
    // The client's complaint: a vertical phone clip came back 844x1500 with
    // black on three sides so the headline could have a strip of its own.
    // The picture keeps the whole frame; the headline goes over its top.
    const frame = aspectRatioFor('9_16');
    const band = bandHeightForFrame(frame);
    const layout = bandLayoutFor(frame, { width: 1080, height: 1920 }, band);

    expect(layout.pictureTop).toBe(0);
    expect(layout.bandTop + band).toBeGreaterThan(layout.pictureTop);
  });

  it('keeps a band laid over the picture below the platforms\' own header', () => {
    // Reels, TikTok and Shorts draw their header across the top of the
    // video; a title at the very edge is half under it once posted.
    for (const ratio of ASPECT_RATIOS) {
      const band = bandHeightForFrame(ratio);
      const layout = bandLayoutFor(ratio, { width: 1080, height: 1920 }, band);
      if (layout.bandTop + band <= layout.pictureTop) continue;
      expect(layout.bandTop).toBe(Math.round(HEADLINE_SAFE_TOP * (ratio.height / REFERENCE_FRAME.height)));
    }
  });

  it('never moves the picture to make room for a headline', () => {
    // Where the picture lands is decided by the source and the frame alone —
    // the same centring the filter graph does with no headline at all.
    for (const ratio of ASPECT_RATIOS) {
      const band = bandHeightForFrame(ratio);
      for (const source of [
        { width: 3840, height: 2160 },
        { width: 1080, height: 1920 },
        { width: 1440, height: 1080 },
        { width: 1080, height: 1080 },
        { width: 1080, height: 1520 },
        { width: 2160, height: 3840 },
      ]) {
        const fitted = Math.min(ratio.height, (ratio.width * source.height) / source.width);
        const expectedTop = Math.round((ratio.height - fitted) / 2);
        expect(bandLayoutFor(ratio, source, band).pictureTop).toBe(expectedTop);
        expect(bandLayoutFor(ratio, source, 0).pictureTop).toBe(expectedTop);
      }
    }
  });

  it('keeps the band inside the frame', () => {
    for (const ratio of ASPECT_RATIOS) {
      const band = bandHeightForFrame(ratio);
      for (const source of [
        { width: 3840, height: 2160 },
        { width: 1080, height: 1920 },
        { width: 1440, height: 1080 },
        { width: 1080, height: 1350 },
        { width: 2160, height: 3840 },
      ]) {
        const layout = bandLayoutFor(ratio, source, band);
        expect(layout.bandTop).toBeGreaterThanOrEqual(0);
        expect(layout.bandTop + band).toBeLessThanOrEqual(ratio.height);
      }
    }
  });

  it('pushes top-aligned captions past where the band ends, not past its height', () => {
    // Those are the same number only while the band starts at the frame's top
    // edge. For a letterboxed source the band sits lower, and measuring by
    // height would put the captions back inside it.
    const frame = aspectRatioFor('9_16');
    const band = bandHeightForFrame(frame);
    const layout = bandLayoutFor(frame, { width: 3840, height: 2160 }, band);
    const top = applyPosition(styleForPreset('classic'), 'top');

    const cleared = clearOfHeadline(top, 'ЗАГОЛОВОК', layout.bandTop + band);
    expect(cleared.marginV).toBeGreaterThan(layout.bandTop + band);
  });

  it('treats an unknown source shape as filling the frame', () => {
    // The commonest upload by far, and the guess that still leaves a usable
    // video: the picture untouched, the headline over its top.
    const frame = aspectRatioFor('9_16');
    const band = bandHeightForFrame(frame);
    for (const unknown of [null, { width: 0, height: 0 }]) {
      const layout = bandLayoutFor(frame, unknown, band);
      expect(layout.pictureTop).toBe(0);
    }
  });

  it('draws the headline in the band the captions are kept clear of', () => {
    // Two places compute this: headline.ts draws inside the band, the
    // pipeline pushes top captions below it. If they disagree the two sets of
    // words overlap, and only a finished render shows it.
    for (const ratio of ASPECT_RATIOS) {
      expect(scaleHeadlineToFrame(DEFAULT_HEADLINE_STYLE, ratio).bandHeight).toBe(bandHeightForFrame(ratio));
    }
  });
});
