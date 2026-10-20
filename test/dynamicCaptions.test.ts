import { describe, it, expect } from 'vitest';
import { buildDynamicEvents, DEFAULT_DYNAMIC_OPTIONS, type SubtitleChunk } from '../src/subtitles';
import { styleForPreset } from '../src/subtitlePresets';
import { loadFontMetrics, measureAssText } from '../src/fontMetrics';
import path from 'node:path';

const metrics = loadFontMetrics(path.join(__dirname, '..', 'assets', 'fonts', 'Montserrat.ttf'));
const measure = (text: string, size: number) => measureAssText(text, metrics, size);
const style = styleForPreset('dynamic');

const chunk: SubtitleChunk = {
  start: 1,
  end: 3.2,
  words: [
    { word: 'Каждая', start: 1, end: 1.4 },
    { word: 'твоя', start: 1.45, end: 1.8 },
    { word: 'история', start: 1.85, end: 2.5 },
    { word: 'важна', start: 2.6, end: 3.1 },
  ],
} as SubtitleChunk;

const parse = (e: string) => ({
  start: e.split(',')[1],
  end: e.split(',')[2],
  pos: /\\pos\((\d+),(\d+)\)/.exec(e)!.slice(1).map(Number),
  size: Number(/\\fs(\d+)/.exec(e)![1]),
  fades: /\\alpha/.test(e),
  pops: /\\fscx80\\fscy80\\t\(0,120,\\fscx100\\fscy100\)/.test(e),
  text: e.slice(e.lastIndexOf('}') + 1),
});

describe('buildDynamicEvents', () => {
  const events = buildDynamicEvents(chunk, style, measure).map(parse);

  it('gives every word its own event, appearing as it is said and lasting to the end of the phrase', () => {
    expect(events.map((e) => e.text)).toEqual(['каждая', 'твоя', 'история', 'важна']);
    expect(events.map((e) => e.start)).toEqual(['0:00:01.00', '0:00:01.45', '0:00:01.85', '0:00:02.60']);
    expect(new Set(events.map((e) => e.end))).toEqual(new Set(['0:00:03.20']));
    expect(events.every((e) => e.pops)).toBe(true);
  });

  it('puts the key word alone on its line, larger, and never dims it', () => {
    const key = events[2];
    expect(key.size).toBeGreaterThan(events[0].size * 1.5);
    expect(key.fades).toBe(false);
    expect(key.pos[1]).not.toBe(events[0].pos[1]);
    expect(key.pos[1]).not.toBe(events[3].pos[1]);
  });

  it('dims the words already said, but not the last', () => {
    expect(events[0].fades).toBe(true);
    expect(events[1].fades).toBe(true);
    expect(events[3].fades).toBe(false);
  });

  it('keeps words on one line side by side, and every line inside the frame', () => {
    expect(events[0].pos[1]).toBe(events[1].pos[1]);
    expect(events[0].pos[0]).toBeLessThan(events[1].pos[0]);
    for (const e of events) {
      const half = measure(e.text, e.size) / 2;
      expect(e.pos[0] - half).toBeGreaterThanOrEqual(0);
      expect(e.pos[0] + half).toBeLessThanOrEqual(style.playResX);
    }
  });

  it('shrinks a word too long for the frame instead of letting it run off', () => {
    const long = { ...chunk, words: [{ word: 'Высокоэффективнейшие', start: 1, end: 2 }] } as SubtitleChunk;
    const [e] = buildDynamicEvents(long, style, measure, { ...DEFAULT_DYNAMIC_OPTIONS, maxWidthRatio: 0.3 }).map(parse);
    expect(measure(e.text, e.size)).toBeLessThanOrEqual(style.playResX * 0.3 + 1);
  });
});
