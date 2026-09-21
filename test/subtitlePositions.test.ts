import { describe, it, expect } from 'vitest';
import { SUBTITLE_POSITIONS, applyPosition, isSubtitlePositionId } from '../src/subtitlePositions';
import { styleForPreset } from '../src/subtitlePresets';
import { DEFAULT_SUBTITLE_STYLE } from '../src/subtitles';

describe('applyPosition', () => {
  it('moves the captions to the top of the frame', () => {
    const style = applyPosition(DEFAULT_SUBTITLE_STYLE, 'top');
    // libass alignment is numpad-shaped: 8 is top centre.
    expect(style.alignment).toBe(8);
  });

  it('moves them to the bottom', () => {
    expect(applyPosition(DEFAULT_SUBTITLE_STYLE, 'bottom').alignment).toBe(2);
  });

  it('keeps them dead centre', () => {
    expect(applyPosition(DEFAULT_SUBTITLE_STYLE, 'center').alignment).toBe(5);
  });

  it('carries a margin that clears the platform UI, not just an alignment', () => {
    // The failure this prevents: alignment alone puts the text under the
    // Reels/Shorts controls at the bottom and under the header at the top,
    // where it is unreadable and invisible from our side.
    expect(applyPosition(DEFAULT_SUBTITLE_STYLE, 'bottom').marginV).toBeGreaterThan(300);
    expect(applyPosition(DEFAULT_SUBTITLE_STYLE, 'top').marginV).toBeGreaterThan(200);
  });

  it('changes nothing else about the look', () => {
    const moved = applyPosition(DEFAULT_SUBTITLE_STYLE, 'top');
    const { alignment: _a, marginV: _m, ...restMoved } = moved;
    const { alignment: _a2, marginV: _m2, ...restOriginal } = DEFAULT_SUBTITLE_STYLE;
    expect(restMoved).toEqual(restOriginal);
  });

  it('leaves the style alone on auto', () => {
    // 'auto' is the absence of an override. This is what keeps the older
    // 'Снизу' preset meaningful — it positions itself, and a blogger who
    // picked it without touching the position control still gets what they
    // picked.
    const lower = styleForPreset('lower');
    expect(applyPosition(lower, 'auto')).toEqual(lower);
    expect(applyPosition(lower, 'auto').alignment).toBe(2);
  });

  it.each([[null], [undefined], ['nonsense']])('treats %s as auto rather than failing a render', (id) => {
    expect(applyPosition(DEFAULT_SUBTITLE_STYLE, id as string | null | undefined)).toEqual(DEFAULT_SUBTITLE_STYLE);
  });

  it('overrides the preset when a position is chosen explicitly', () => {
    // The more recent thing the person said wins: they picked the bottom
    // style, then moved the captions to the top.
    expect(applyPosition(styleForPreset('lower'), 'top').alignment).toBe(8);
  });
});

describe('SUBTITLE_POSITIONS', () => {
  it('offers exactly one option per placement, auto included', () => {
    expect(SUBTITLE_POSITIONS.map((p) => p.id)).toEqual(['auto', 'top', 'center', 'bottom']);
  });

  it('gives every real position both an alignment and a margin', () => {
    // Neither is useful without the other, so a position missing one would
    // silently render somewhere nobody chose.
    for (const position of SUBTITLE_POSITIONS.filter((p) => p.id !== 'auto')) {
      expect(position.alignment, position.id).not.toBeNull();
      expect(position.marginV, position.id).not.toBeNull();
    }
  });

  it('recognises its own ids and nothing else', () => {
    expect(isSubtitlePositionId('bottom')).toBe(true);
    expect(isSubtitlePositionId('lower')).toBe(false);
    expect(isSubtitlePositionId(5)).toBe(false);
  });
});
