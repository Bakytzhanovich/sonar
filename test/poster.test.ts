import { describe, it, expect } from 'vitest';
import {
  buildPosterEvents,
  DEFAULT_POSTER_OPTIONS,
  DEFAULT_SUBTITLE_STYLE,
  type MeasureText,
  type SubtitleChunk,
} from '../src/subtitles';

// A measurer with no font behind it: every character is half the font size
// wide. The layout rules are what these tests are about, and a real font
// would make every expected number depend on a typeface's design.
const measure: MeasureText = (text, size) => text.length * size * 0.5;

function chunk(...words: string[]): SubtitleChunk {
  const spans = words.map((word, i) => ({ word, start: i * 0.4, end: (i + 1) * 0.4 }));
  return { words: spans, start: 0, end: words.length * 0.4 };
}

const style = { ...DEFAULT_SUBTITLE_STYLE, playResX: 1080, playResY: 1920, fontSize: 64 };

// Every line of the stack is placed by hand, so the numbers in the tags are
// the feature rather than an implementation detail.
function positionsOf(events: string[]): Array<{ y: number; size: number }> {
  return events.map((event) => {
    const pos = /\\pos\(\d+,(-?\d+)\)/.exec(event);
    const size = /\\fs(\d+)/.exec(event);
    return { y: Number(pos?.[1]), size: Number(size?.[1]) };
  });
}

describe('buildPosterEvents', () => {
  it('splits the caption into quiet lines around one loud one', () => {
    const events = buildPosterEvents(chunk('дают', 'большой', 'результат'), style, measure);

    // "дают большой" above, "результат" below — three words, emphasis last,
    // so there is nothing after it.
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('дают большой');
    expect(events[1]).toContain('РЕЗУЛЬТАТ');
  });

  it('sets the emphasised word far larger than the rest', () => {
    const [quiet, loud] = positionsOf(buildPosterEvents(chunk('это', 'работает'), style, measure));
    expect(loud.size).toBeGreaterThan(quiet.size * 1.5);
  });

  // The overlap is the whole look: without it this is an ordinary two-line
  // caption. Lines must sit closer than their own heights would allow.
  it('stacks the lines so they bite into each other', () => {
    const placed = positionsOf(buildPosterEvents(chunk('вышел', 'убийца', 'монтажеров'), style, measure));
    const gap = placed[1].y - placed[0].y;
    const halves = (placed[0].size * 1.2) / 2 + (placed[1].size * 1.2) / 2;
    expect(gap).toBeLessThan(halves);
  });

  // libass draws an overlong line straight off the edge of the frame and
  // logs nothing, so this is the check that the fitting happened at all.
  it('shrinks a long word to fit the frame instead of letting it overflow', () => {
    const events = buildPosterEvents(chunk('слово', 'переосвидетельствование'), style, measure);
    const loud = positionsOf(events).find((p) => p.size > style.fontSize)!;
    expect(measure('ПЕРЕОСВИДЕТЕЛЬСТВОВАНИЕ', loud.size)).toBeLessThanOrEqual(
      style.playResX * DEFAULT_POSTER_OPTIONS.maxWidthRatio
    );
  });

  // A word so long that fitting it leaves nothing to emphasise: shouting it
  // at 20px is not a design, it is a bug that looks deliberate.
  it('falls back to a flat caption when the word cannot be shouted', () => {
    const wide: MeasureText = (text, size) => text.length * size * 8;
    const events = buildPosterEvents(chunk('слово', 'результат'), style, wide);
    expect(events.every((e) => !e.includes('\\pos'))).toBe(true);
  });

  // pickEmphasis answering null has to survive all the way out here.
  it('falls back to a flat caption when nothing earns emphasis', () => {
    const events = buildPosterEvents(chunk('и', 'в', 'на'), style, measure);
    expect(events.every((e) => !e.includes('\\pos'))).toBe(true);
  });

  it('keeps the caption inside the frame it was given', () => {
    const placed = positionsOf(buildPosterEvents(chunk('дают', 'большой', 'результат'), style, measure));
    for (const line of placed) {
      expect(line.y).toBeGreaterThan(0);
      expect(line.y).toBeLessThan(style.playResY);
    }
  });

  // The position the user picked still decides where the block lands; a new
  // style that ignored it would be a new way to surprise them.
  it('honours a top or bottom placement', () => {
    const top = positionsOf(buildPosterEvents(chunk('это', 'результат'), { ...style, alignment: 8, marginV: 200 }, measure));
    const bottom = positionsOf(buildPosterEvents(chunk('это', 'результат'), { ...style, alignment: 2, marginV: 200 }, measure));
    expect(top[0].y).toBeLessThan(style.playResY / 2);
    expect(bottom[bottom.length - 1].y).toBeGreaterThan(style.playResY / 2);
  });

  it('holds every line for the whole caption rather than flashing them in turn', () => {
    const events = buildPosterEvents(chunk('дают', 'большой', 'результат'), style, measure);
    const times = events.map((e) => /Dialogue: 0,([^,]+),([^,]+),/.exec(e)!.slice(1, 3).join('-'));
    expect(new Set(times).size).toBe(1);
  });
});
