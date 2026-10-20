import { describe, it, expect } from 'vitest';
import { buildSlamEvents, wordAnchorY, type SubtitleChunk } from '../src/subtitles';
import { styleForPreset } from '../src/subtitlePresets';
import { buildFitChain } from '../src/ffmpeg';
import { buildHeadlineAss, DEFAULT_HEADLINE_STYLE } from '../src/headline';

const style = styleForPreset('slam');
const chunk = {
  start: 0,
  end: 2,
  words: [
    { word: 'Это', start: 0, end: 0.3 },
    { word: '99%', start: 0.35, end: 0.8 },
    { word: 'предприниматели', start: 1.2, end: 1.9 },
  ],
} as SubtitleChunk;

describe('"Удар" captions', () => {
  const events = buildSlamEvents(chunk, style, 838);
  it('shows one word at a time, in capitals, italic, never wrapped, at the anchor', () => {
    expect(events.map((e) => e.slice(e.lastIndexOf('}') + 1))).toEqual(['ЭТО', '99%', 'ПРЕДПРИНИМАТЕЛИ']);
    for (const e of events) expect(e).toContain('\\an5\\pos(540,838)\\i1\\q2');
  });
  it('joins a gap too short to see, and leaves a real pause empty', () => {
    expect(events[0].split(',')[2]).toBe('0:00:00.35'); // held to the next word across 0.05s
    expect(events[1].split(',')[2]).toBe('0:00:00.80'); // gone at its end: 0.4s of nothing follows
  });
  it('puts the word at eye level of the picture, not of the frame', () => {
    expect(wordAnchorY(1920, 0)).toBe(576);
    expect(wordAnchorY(1920, 656)).toBe(838);
  });
  it('is large enough that an ordinary word fills most of the frame', () => {
    expect(style.fontSize).toBeGreaterThanOrEqual(280);
  });
});

describe('frame fill', () => {
  const frame = { width: 1080, height: 1920 };
  it('pads with black, with no blurred copy, when asked', () => {
    const chain = buildFitChain('[v]', frame, null, 'black');
    expect(chain).toContain('pad=1080:1920');
    expect(chain).toContain('color=black');
    expect(chain).not.toContain('gblur');
  });
  it('keeps the blurred fill by default', () => {
    expect(buildFitChain('[v]', frame, null)).toContain('gblur');
  });
});

describe('headline duration', () => {
  it('holds for the whole clip by default, or for the first N seconds', () => {
    expect(buildHeadlineAss('Заголовок', DEFAULT_HEADLINE_STYLE)).toContain('0:00:00.00,9:59:59.99');
    expect(buildHeadlineAss('Заголовок', { ...DEFAULT_HEADLINE_STYLE, seconds: 7 })).toContain('0:00:00.00,0:00:07.00');
  });
});
