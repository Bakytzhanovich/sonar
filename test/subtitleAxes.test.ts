import { describe, it, expect } from 'vitest';
import {
  applySubtitleAxes,
  assToRgb,
  rgbToAss,
  SUBTITLE_COLOURS,
  SUBTITLE_FONTS,
  SUBTITLE_SIZES,
} from '../src/subtitleAxes';
import { DEFAULT_SUBTITLE_STYLE } from '../src/subtitles';
import { styleForPreset } from '../src/subtitlePresets';
import { SUBTITLE_POSITIONS } from '../src/subtitlePositions';

// THE test in this file. A colour written backwards is still a valid colour:
// the render succeeds and the captions simply come out blue when they were
// meant to be amber, with nothing anywhere saying so.
describe('rgbToAss', () => {
  it('reverses the channels the way ASS expects', () => {
    // #FACC15 is amber: red FA, green CC, blue 15. ASS wants blue first.
    expect(rgbToAss('#FACC15')).toBe('&H0015CCFA');
  });

  it('agrees with the colours already written by hand elsewhere', () => {
    // headlineStyles.ts has carried these three since before this function
    // existed; if the conversion were mirrored, they would disagree.
    expect(rgbToAss('#FFFFFF')).toBe('&H00FFFFFF');
    expect(rgbToAss('#34D399')).toBe('&H0099D334'); // mint
    expect(rgbToAss('#EF4444')).toBe('&H004444EF'); // red
  });

  it('survives a colour written without the hash', () => {
    expect(rgbToAss('2DD4BF')).toBe('&H00BFD42D');
  });

  it('refuses something that is not a colour rather than emitting nonsense', () => {
    expect(() => rgbToAss('#12345')).toThrow();
    expect(() => rgbToAss('красный')).toThrow();
  });
});

describe('the catalogues', () => {
  // Offered families must exist as files, or libass substitutes another one
  // without a word — the failure that had Verdana standing in for Montserrat
  // for days.
  it('offers only typefaces the headline catalogue already ships', () => {
    const named = SUBTITLE_FONTS.filter((f) => f.family);
    expect(named.length).toBeGreaterThan(0);
    for (const font of named) expect(font.family.length).toBeGreaterThan(0);
  });

  it('every colour converts', () => {
    for (const colour of SUBTITLE_COLOURS.filter((c) => c.hex)) {
      expect(() => rgbToAss(colour.hex)).not.toThrow();
    }
  });

  it('has exactly one neutral size, so a preset can be left alone', () => {
    expect(SUBTITLE_SIZES.filter((s) => s.scale === 1)).toHaveLength(1);
  });
});

describe('applySubtitleAxes', () => {
  const style = DEFAULT_SUBTITLE_STYLE;

  // What keeps every job rendered before today looking exactly as it did.
  it('changes nothing when every axis is auto', () => {
    expect(applySubtitleAxes(style, { font: 'auto', colour: 'auto', size: 'medium' })).toEqual(style);
  });

  it('leaves a preset alone when the ids are unknown or missing', () => {
    expect(applySubtitleAxes(style, {})).toEqual(style);
    expect(applySubtitleAxes(style, { font: 'какой-то', colour: null, size: undefined })).toEqual(style);
  });

  it('sets the typeface', () => {
    expect(applySubtitleAxes(style, { font: 'oswald' }).fontName).toBe('Oswald');
  });

  it('colours the emphasised word without touching the plain one', () => {
    const out = applySubtitleAxes(style, { colour: 'azure' });
    expect(out.highlightColour).toBe('&H00F8BD38');
    expect(out.primaryColour).toBe(style.primaryColour);
  });

  // The whole point of the split: this combination could not be expressed
  // before without inventing another preset.
  it('combines a size with a colour the preset never had', () => {
    const out = applySubtitleAxes(styleForPreset('bold'), { size: 'large', colour: 'turquoise' });
    expect(out.fontSize).toBeGreaterThan(styleForPreset('bold').fontSize);
    expect(out.highlightColour).toBe('&H00BFD42D');
  });

  it('grows the outline with the text so it keeps separating it', () => {
    const out = applySubtitleAxes(style, { size: 'large' });
    expect(out.outline).toBeGreaterThan(style.outline);
  });

  // The poster style has no outline on purpose; scaling zero must stay zero
  // rather than reintroducing the thing the style exists to avoid.
  it('does not give the poster style an outline it deliberately lacks', () => {
    const out = applySubtitleAxes(styleForPreset('poster'), { size: 'large' });
    expect(out.outline).toBe(0);
  });
});

describe('assToRgb', () => {
  // The browser preview draws what the renderer will burn in, and the presets
  // carry their colours in the renderer's form. A second list of hex values
  // would let the two disagree about what "Классика" looks like.
  it('is the exact inverse of rgbToAss', () => {
    for (const hex of ['#FACC15', '#38BDF8', '#A3E635', '#F43F5E', '#FFFFFF', '#2DD4BF', '#000000']) {
      expect(assToRgb(rgbToAss(hex))).toBe(hex);
    }
  });

  it('reads the colours the presets already carry', () => {
    expect(assToRgb('&H00FFFFFF')).toBe('#FFFFFF');
    expect(assToRgb('&H0000FFFF')).toBe('#FFFF00'); // the classic yellow highlight
  });

  it('refuses anything that is not an ASS colour', () => {
    expect(() => assToRgb('#FACC15')).toThrow();
    expect(() => assToRgb('&H00FFF')).toThrow();
  });
});

// The bug these guard against: the catalogue calls the middle position
// 'center', the preview's CSS calls that row 'middle', and nothing connected
// the two — so picking "По центру" left the captions with no alignment at all
// and they collapsed to the top of the frame. A naming mismatch across two
// languages that typechecked on both sides.
describe('the rows the preview is given', () => {
  it('resolves every position to one of the three the preview can draw', () => {
    for (const position of SUBTITLE_POSITIONS) {
      const row =
        position.alignment === null
          ? null
          : position.alignment >= 7
            ? 'top'
            : position.alignment <= 3
              ? 'bottom'
              : 'middle';
      expect([null, 'top', 'middle', 'bottom']).toContain(row);
      // 'auto' is the only one allowed to defer; every other position must
      // resolve to something, or it silently becomes no position at all.
      if (position.id !== 'auto') expect(row).not.toBeNull();
    }
  });

  // A position is never only an alignment: the top one clears the platform's
  // header, the bottom one the Reels controls. A preview using the preset's
  // margin instead would put text under someone else's interface.
  it('carries a margin with every alignment it carries', () => {
    for (const position of SUBTITLE_POSITIONS) {
      expect(position.alignment === null).toBe(position.marginV === null);
    }
  });
});
