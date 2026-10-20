import { describe, it, expect } from 'vitest';
import { buildTopicEvents, heuristicMarkup, validateMarkup, ACCENT_GAP_SEC } from '../src/topicLayout';
import { markupCaptions } from '../src/captionMarkup';
import { buildEndCardEvents, cleanEndCard, endCardAss } from '../src/endCard';
import { scaleStyleToFrame, type SubtitleChunk } from '../src/subtitles';
import { styleForPreset } from '../src/subtitlePresets';

const w = (word: string, start: number, end: number) => ({ word, start, end });
const chunks = [
  { start: 0, end: 2, words: [w('Знаете', 0, 0.4), w('почему', 0.45, 0.8), w('люди', 0.9, 1.3), w('не', 1.35, 1.5), w('покупают', 1.55, 2)] },
  { start: 2.4, end: 4.6, words: [w('потому', 2.4, 2.8), w('что', 2.85, 3), w('им', 3.05, 3.2), w('страшно', 3.3, 4.6)] },
  { start: 5, end: 7, words: [w('а', 5, 5.1), w('цена', 5.2, 6), w('вторична', 6.1, 7)] },
] as SubtitleChunk[];
const style = scaleStyleToFrame(styleForPreset('topic'), { width: 1080, height: 1920 });
const measure = (text: string, size: number) => text.length * size * 0.5;

describe('validateMarkup', () => {
  it('keeps a consistent answer and drops what does not fit the phrases', () => {
    const m = validateMarkup(
      {
        topics: [
          { from: 0, to: 1, keyword: '«Продажи»!' },
          { from: 1, to: 2, keyword: 'перекрытие' }, // overlaps the first: dropped
          { from: 2, to: 9, keyword: 'вне' }, // past the end: dropped
        ],
        keyStart: [2, 99, 1],
        accents: [{ chunk: 1, word: 3 }, { chunk: 2, word: 1 }],
      },
      chunks
    );
    expect(m?.topics).toEqual([{ from: 0, to: 1, keyword: 'Продажи' }]);
    expect(m?.keyStart).toEqual([2, 2, 1]); // 99 is out of range: the half-way default
    // The second accent is closer than ACCENT_GAP_SEC to the first.
    expect(chunks[2].start - chunks[1].start).toBeLessThan(ACCENT_GAP_SEC);
    expect(m?.accents).toEqual([{ chunk: 1, word: 3 }]);
  });

  it('returns null for an answer with no usable topic', () => {
    expect(validateMarkup(null, chunks)).toBeNull();
    expect(validateMarkup({ topics: 'нет' }, chunks)).toBeNull();
  });
});

describe('heuristicMarkup', () => {
  it('names topics with the emphasis word and invents no feelings', () => {
    const m = heuristicMarkup(chunks);
    expect(m.topics.length).toBeGreaterThan(0);
    expect(m.accents).toEqual([]);
    expect(m.keyStart).toEqual([2, 2, 1]);
  });
});

describe('buildTopicEvents', () => {
  const markup = { topics: [{ from: 0, to: 1, keyword: 'Продажи' }], keyStart: [2, 2, 1], accents: [{ chunk: 1, word: 3 }] };
  const events = buildTopicEvents(chunks, markup, style, { keyword: measure, key: measure });
  const text = (e: string) => e.slice(e.lastIndexOf('}') + 1);

  it('holds the topic word over its phrases, in capitals', () => {
    const kw = events.find((e) => text(e) === 'ПРОДАЖИ')!;
    expect(kw.split(',').slice(1, 3)).toEqual(['0:00:00.00', '0:00:04.60']);
  });

  it('shows the lead-in from the phrase start and the key part when it is said', () => {
    const lead = events.find((e) => text(e) === 'ЗНАЕТЕ ПОЧЕМУ')!;
    const key = events.find((e) => text(e) === 'ЛЮДИ НЕ ПОКУПАЮТ')!;
    expect(lead.split(',')[1]).toBe('0:00:00.00');
    expect(lead).toMatch(/\\fsp\d+/);
    expect(key.split(',')[1]).toBe('0:00:00.90');
  });

  it('writes the accent in handwriting, tilted, lower case', () => {
    const accent = events.find((e) => text(e) === 'страшно')!;
    expect(accent).toContain('\\fnCaveat');
    expect(accent).toContain('\\frz8');
  });

  it('keeps every text inside the frame width', () => {
    for (const e of events) {
      const size = Number(/\\fs(\d+)/.exec(e)![1]);
      if (/\\fsp/.test(e)) continue; // the spaced lead line is small by design
      expect(measure(text(e), size)).toBeLessThanOrEqual(style.playResX + 1);
    }
  });
});

describe('markupCaptions', () => {
  it('uses the model when it answers well', async () => {
    const chat = async () => JSON.stringify({ topics: [{ from: 0, to: 2, keyword: 'страх' }], keyStart: [1, 1, 1], accents: [] });
    expect((await markupCaptions(chat, chunks))?.topics[0].keyword).toBe('страх');
  });
  it('returns null, never throws, when the model fails or talks nonsense', async () => {
    expect(await markupCaptions(async () => 'не JSON', chunks)).toBeNull();
    expect(await markupCaptions(async () => { throw new Error('down'); }, chunks)).toBeNull();
  });
});

describe('end card', () => {
  const frame = { width: 1080, height: 1920 };
  it('draws nothing when empty, and covers the last two seconds otherwise', () => {
    expect(buildEndCardEvents(frame, 10, cleanEndCard({}))).toEqual([]);
    const events = buildEndCardEvents(frame, 10, cleanEndCard({ text: 'Подпишись, чтобы не пропустить разбор', brand: 'Sonar', cta: 'Подписаться' }));
    expect(events[0]).toContain('0:00:08.00,0:00:11.00');
    expect(events.some((e) => e.endsWith('РАЗБОР'))).toBe(true); // every word kept
    expect(events.some((e) => e.endsWith('SONAR') && e.includes('&H001C148C'))).toBe(true);
    expect(events.some((e) => e.endsWith('ПОДПИСАТЬСЯ'))).toBe(true);
    expect(endCardAss(frame, events)).toContain('PlayResY: 1920');
  });
  it('strips what could break out of an ASS override', () => {
    expect(cleanEndCard({ text: 'a{\\pos(0,0)}b' }).text).not.toContain('{');
  });
});
