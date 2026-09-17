import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUBTITLE_PRESET,
  isSubtitlePresetId,
  styleForPreset,
  SUBTITLE_PRESETS,
} from '../src/subtitlePresets';
import { buildSubtitlesFromLines, DEFAULT_SUBTITLE_STYLE } from '../src/subtitles';

describe('subtitle presets', () => {
  it('falls back instead of failing a render on an unknown id', () => {
    // The id can only come from a stale client or an older row; a caption
    // look is not worth losing the render over.
    expect(styleForPreset('does-not-exist')).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(styleForPreset(null)).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(styleForPreset(undefined)).toEqual(DEFAULT_SUBTITLE_STYLE);
  });

  it('has a default that is one of the presets', () => {
    expect(SUBTITLE_PRESETS.some((p) => p.id === DEFAULT_SUBTITLE_PRESET)).toBe(true);
  });

  it('writes colours in ASS byte order, not RGB', () => {
    // &HAABBGGRR — alpha, blue, green, red. Written as RRGGBB the colour is
    // silently wrong: no error, just the wrong render.
    for (const preset of SUBTITLE_PRESETS) {
      for (const colour of [preset.style.primaryColour, preset.style.highlightColour, preset.style.outlineColour]) {
        expect(colour).toMatch(/^&H[0-9A-F]{8}$/);
      }
    }
    // The accent preset is rose-700 #be123c, which is 3C12BE in BGR.
    const accent = SUBTITLE_PRESETS.find((p) => p.id === 'accent');
    expect(accent?.style.highlightColour).toBe('&H003C12BE');
  });

  it('keeps bottom-anchored captions clear of the platforms\' own controls', () => {
    // marginV only means "distance from the bottom" when the text is
    // anchored there (alignment 2). Centred presets are unaffected by it,
    // which is exactly the trap: setting the margin on a centred style moves
    // nothing and looks like it worked.
    for (const preset of SUBTITLE_PRESETS) {
      if (preset.style.alignment !== 2) continue;
      // Reels, Shorts and TikTok cover roughly the lower fifth of 1920.
      expect(preset.style.marginV).toBeGreaterThanOrEqual(300);
    }
  });

  it('has at least one bottom-anchored preset, since centred is not always right', () => {
    expect(SUBTITLE_PRESETS.some((p) => p.style.alignment === 2)).toBe(true);
  });

  it('grows the outline with the type size', () => {
    // Heavier letters over a bright frame need more separation, not the same.
    const bold = SUBTITLE_PRESETS.find((p) => p.id === 'bold')!;
    const minimal = SUBTITLE_PRESETS.find((p) => p.id === 'minimal')!;
    expect(bold.style.fontSize).toBeGreaterThan(minimal.style.fontSize);
    expect(bold.style.outline).toBeGreaterThan(minimal.style.outline);
  });

  it('reaches the rendered file', () => {
    const lines = [{ start: 0, end: 1, text: 'привет мир' }];
    const { ass } = buildSubtitlesFromLines(lines, styleForPreset('bold'));
    // The style line carries the font size, so a preset that never reached
    // the renderer would be invisible in the output.
    expect(ass).toContain(',82,');
  });

  it('recognises only real ids', () => {
    expect(isSubtitlePresetId('classic')).toBe(true);
    expect(isSubtitlePresetId('nope')).toBe(false);
    expect(isSubtitlePresetId(42)).toBe(false);
  });
});
