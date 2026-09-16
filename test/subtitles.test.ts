import { describe, it, expect } from 'vitest';
import {
  buildAssFile,
  buildSubtitlesForPlan,
  chunkWords,
  DEFAULT_CHUNK_OPTIONS,
  DEFAULT_SUBTITLE_STYLE,
  formatAssTime,
  remapWordsToOutputTimeline,
} from '../src/subtitles';
import type { TranscriptWord } from '../src/smartCut';

function words(...spec: Array<[string, number, number]>): TranscriptWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

// Evenly spaced words, one per second, for tests about grouping rather than timing.
function evenWords(...list: string[]): TranscriptWord[] {
  return list.map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 }));
}

describe('chunkWords', () => {
  it('groups words into blocks of at most maxWords', () => {
    const chunks = chunkWords(evenWords('раз', 'два', 'три', 'четыре', 'пять', 'шесть'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].words.map((w) => w.word)).toEqual(['раз', 'два', 'три', 'четыре']);
    expect(chunks[1].words.map((w) => w.word)).toEqual(['пять', 'шесть']);
  });

  it('breaks early when the line would exceed maxChars', () => {
    // Four words here are 40+ characters — unreadable at a glance, which is
    // why the limit is on characters and not only on word count.
    const chunks = chunkWords(evenWords('экспериментировать', 'систематически', 'невозможно'));

    for (const chunk of chunks) {
      const length = chunk.words.map((w) => w.word).join(' ').length;
      expect(length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
    }
  });

  it('breaks on a long pause between words', () => {
    const chunks = chunkWords(words(['раз', 0, 0.3], ['два', 0.4, 0.7], ['три', 2.0, 2.3]));

    expect(chunks).toHaveLength(2);
    expect(chunks[1].words.map((w) => w.word)).toEqual(['три']);
  });

  it('breaks at the end of a sentence', () => {
    const chunks = chunkWords(evenWords('это', 'важно.', 'теперь', 'дальше'));

    expect(chunks[0].words.map((w) => w.word)).toEqual(['это', 'важно.']);
    expect(chunks[1].words.map((w) => w.word)).toEqual(['теперь', 'дальше']);
  });

  it('carries each word\'s absolute timecodes through unchanged', () => {
    const chunks = chunkWords(words(['раз', 1.25, 1.6], ['два', 1.7, 2.1]));

    expect(chunks[0].words[0]).toEqual({ word: 'раз', start: 1.25, end: 1.6 });
    expect(chunks[0].start).toBe(1.25);
    expect(chunks[0].end).toBe(2.1);
  });

  it('holds a very short chunk on screen long enough to read', () => {
    const chunks = chunkWords(words(['да', 0, 0.1]));
    expect(chunks[0].end - chunks[0].start).toBeGreaterThanOrEqual(DEFAULT_CHUNK_OPTIONS.minDurationSec);
  });

  it('never extends a chunk over the start of the next one', () => {
    // Two rapid chunks separated by a long pause-triggered break: extending
    // the first to its minimum would otherwise overlap the second, and two
    // captions would be on screen at once.
    const chunks = chunkWords(words(['да', 0, 0.05], ['нет', 0.2, 0.25]), {
      ...DEFAULT_CHUNK_OPTIONS,
      maxWords: 1,
      minWords: 1,
    });

    expect(chunks[0].end).toBeLessThanOrEqual(chunks[1].start);
  });

  it('ignores empty tokens instead of emitting blank captions', () => {
    const chunks = chunkWords(words(['раз', 0, 0.3], ['   ', 0.3, 0.4], ['два', 0.4, 0.7]));
    expect(chunks[0].words.map((w) => w.word)).toEqual(['раз', 'два']);
  });

  it('returns nothing for an empty transcript', () => {
    expect(chunkWords([])).toEqual([]);
  });
});

describe('remapWordsToOutputTimeline', () => {
  const segments = [{ start: 0, end: 2 }, { start: 10, end: 12 }];

  it('shifts words by the amount of removed time before them', () => {
    // Without this the caption for a word at 10s would be burned at 10s in an
    // output where that moment is 2s in — eight seconds out of sync.
    const remapped = remapWordsToOutputTimeline(words(['раз', 0.5, 1.0], ['два', 10.5, 11.0]), segments);

    expect(remapped).toEqual([
      { word: 'раз', start: 0.5, end: 1.0 },
      { word: 'два', start: 2.5, end: 3.0 },
    ]);
  });

  it('drops words that fell entirely inside a removed region', () => {
    const remapped = remapWordsToOutputTimeline(words(['ну', 5.0, 5.3]), segments);
    expect(remapped).toEqual([]);
  });

  it('clips a word straddling a cut boundary instead of dropping it', () => {
    // The first half of the syllable is still audible in the output, so the
    // caption should still be there.
    const remapped = remapWordsToOutputTimeline(words(['длинное', 1.5, 3.0]), segments);
    expect(remapped).toEqual([{ word: 'длинное', start: 1.5, end: 2 }]);
  });

  it('returns words in output order', () => {
    const remapped = remapWordsToOutputTimeline(words(['b', 10.1, 10.4], ['a', 0.1, 0.4]), segments);
    expect(remapped.map((w) => w.word)).toEqual(['a', 'b']);
  });
});

describe('formatAssTime', () => {
  it.each([
    [0, '0:00:00.00'],
    [1.25, '0:00:01.25'],
    [61.5, '0:01:01.50'],
    [3723.04, '1:02:03.04'],
  ])('formats %s as %s', (seconds, expected) => {
    expect(formatAssTime(seconds)).toBe(expected);
  });

  it('never emits a negative time', () => {
    expect(formatAssTime(-5)).toBe('0:00:00.00');
  });
});

describe('buildAssFile', () => {
  const chunks = chunkWords(evenWords('раз', 'два', 'три'));
  const ass = buildAssFile(chunks);

  it('declares the style the ТЗ asks for', () => {
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain(`Style: Caption,${DEFAULT_SUBTITLE_STYLE.fontName},64,`);
    // Bold on, outline 3, shadow 2, alignment 5 (centre).
    expect(ass).toMatch(/Style: Caption,[^\n]*,-1,0,0,0,100,100,0,0,1,3,2,5,/);
  });

  it('sets PlayRes to the output resolution', () => {
    // libass scales font size and margins against PlayRes; a mismatch with the
    // real frame silently rescales every caption.
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('emits one event per word, each highlighting a different one', () => {
    const events = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(events).toHaveLength(3);

    expect(events[0]).toContain('{\\c&H0000FFFF}раз{\\c} два три');
    expect(events[1]).toContain('раз {\\c&H0000FFFF}два{\\c} три');
    expect(events[2]).toContain('раз два {\\c&H0000FFFF}три{\\c}');
  });

  it('keeps the caption on screen continuously across a chunk', () => {
    const events = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    const endOfFirst = events[0].split(',')[2];
    const startOfSecond = events[1].split(',')[1];
    // Each event ends exactly where the next begins — no gap, so the block
    // does not flicker off between words.
    expect(endOfFirst).toBe(startOfSecond);
  });

  it('strips ASS tag syntax the transcript may carry', () => {
    // The text comes from a user-supplied video via Whisper, so an override
    // block reaching the file verbatim would let it restyle or reposition the
    // captions — and stripping only the braces leaves the tag as visible text.
    const ass = buildAssFile(chunkWords(words(['{\\an8}вот', 0, 0.4])));
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))[0];

    expect(dialogue).not.toContain('an8');
    expect(dialogue).toContain('вот');
  });

  it('strips a bare backslash, which is the ASS escape character', () => {
    // '\\N' left in the text is a hard line break, which would split a caption
    // that is supposed to be one centred line.
    const ass = buildAssFile(chunkWords(words(['раз\\Nдва', 0, 0.4])));
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))[0];
    expect(dialogue).toContain('разNдва');
  });

  it('produces a valid file with no events for an empty transcript', () => {
    const empty = buildAssFile([]);
    expect(empty).toContain('[Events]');
    expect(empty.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(0);
  });
});

describe('buildSubtitlesForPlan', () => {
  it('remaps, chunks and renders in one step', () => {
    const { ass, chunks } = buildSubtitlesForPlan(
      words(['раз', 0.5, 1.0], ['два', 10.5, 11.0]),
      [{ start: 0, end: 2 }, { start: 10, end: 12 }]
    );

    expect(chunks).toHaveLength(2); // the 8s gap is gone, but a break remains
    // Second caption is at 2.5s in the output, not 10.5s in the source.
    expect(ass).toContain('0:00:02.50');
  });
});
