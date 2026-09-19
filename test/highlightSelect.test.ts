import { describe, it, expect } from 'vitest';
import {
  buildHighlightPrompt,
  groupIntoSentences,
  resolveHighlight,
  wordsInSpan,
  type Sentence,
} from '../src/highlightSelect';
import type { TranscriptWord } from '../src/smartCut';

function words(spec: Array<[string, number, number]>): TranscriptWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

describe('groupIntoSentences', () => {
  it('breaks on sentence-ending punctuation', () => {
    const out = groupIntoSentences(words([
      ['Привет,', 0, 0.4], ['друзья.', 0.4, 0.9],
      ['Сегодня', 1.0, 1.4], ['поговорим', 1.4, 2.0],
    ]));
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('Привет, друзья.');
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(0.9);
  });

  it('breaks on a long pause, because speech has few full stops', () => {
    // A transcript of talking rarely carries punctuation at all, so silence
    // has to do the work that a full stop does in writing.
    const out = groupIntoSentences(words([
      ['одна', 0, 0.5], ['мысль', 0.5, 1.0],
      ['другая', 3.0, 3.5], ['мысль', 3.5, 4.0],
    ]));
    expect(out).toHaveLength(2);
    expect(out[1].start).toBe(3.0);
  });

  it('numbers the lines so the model can point at one', () => {
    const out = groupIntoSentences(words([['а.', 0, 1], ['б.', 1, 2], ['в.', 2, 3]]));
    expect(out.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('returns nothing for nothing', () => {
    expect(groupIntoSentences([])).toEqual([]);
  });
});

describe('buildHighlightPrompt', () => {
  const sentences: Sentence[] = [
    { index: 0, start: 0, end: 5, text: 'Первая мысль.' },
    { index: 1, start: 5, end: 12, text: 'Вторая мысль.' },
  ];

  it('gives the model numbers, times and the target it must hit', () => {
    const prompt = buildHighlightPrompt(sentences, 60);
    expect(prompt).toContain('[0] 0.0–5.0s: Первая мысль.');
    expect(prompt).toContain('[1] 5.0–12.0s: Вторая мысль.');
    expect(prompt).toContain('60 секунд');
    // Asking for bare JSON is what makes the answer checkable at all.
    expect(prompt).toContain('"from"');
  });
});

describe('resolveHighlight', () => {
  const sentences: Sentence[] = [
    { index: 0, start: 0, end: 20, text: 'а' },
    { index: 1, start: 20, end: 40, text: 'б' },
    { index: 2, start: 40, end: 70, text: 'в' },
    { index: 3, start: 70, end: 200, text: 'г' },
  ];

  it('turns a sentence range into a time span', () => {
    const out = resolveHighlight('{"from":0,"to":2,"why":"сильное начало"}', sentences, 60);
    expect(out).toEqual({ ok: true, span: { start: 0, end: 70 }, why: 'сильное начало' });
  });

  it('digs the JSON out of whatever the model wrapped it in', () => {
    const out = resolveHighlight('Конечно!\n```json\n{"from":1,"to":2}\n```\n', sentences, 50);
    expect(out.ok).toBe(true);
  });

  it('refuses a range that points outside the transcript', () => {
    // The failure that matters: times taken from nowhere would cut a client's
    // video at invented points and look deliberate.
    expect(resolveHighlight('{"from":0,"to":99}', sentences, 60))
      .toEqual({ ok: false, reason: 'out_of_range' });
    expect(resolveHighlight('{"from":2,"to":1}', sentences, 60))
      .toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('refuses an answer that is not the length that was asked for', () => {
    // Sentences 0–3 are 200 seconds. However good, it is not a 60-second clip.
    expect(resolveHighlight('{"from":0,"to":3}', sentences, 60))
      .toEqual({ ok: false, reason: 'too_far_from_target' });
  });

  it('accepts a near miss, because sentences do not divide evenly', () => {
    // 40 seconds against a 60-second request: rejecting this would throw away
    // the thing we asked for over arithmetic.
    const out = resolveHighlight('{"from":0,"to":1}', sentences, 60);
    expect(out.ok).toBe(true);
  });

  it('refuses gibberish rather than guessing', () => {
    expect(resolveHighlight('не знаю', sentences, 60)).toEqual({ ok: false, reason: 'unparseable' });
    expect(resolveHighlight('{"from":"а","to":"б"}', sentences, 60)).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('refuses when there is no transcript at all', () => {
    expect(resolveHighlight('{"from":0,"to":0}', [], 60)).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('wordsInSpan', () => {
  it('keeps only whole words inside the span', () => {
    const all = words([['а', 0, 1], ['б', 1, 2], ['в', 2, 3], ['г', 3, 4]]);
    expect(wordsInSpan(all, { start: 1, end: 3 }).map((w) => w.word)).toEqual(['б', 'в']);
  });

  it('leaves the timings on the source timeline', () => {
    // They are remapped later, by the same code that handles the cuts — doing
    // it twice, in two places, is how captions drift.
    const all = words([['а', 10, 11], ['б', 11, 12]]);
    expect(wordsInSpan(all, { start: 10, end: 12 })[0].start).toBe(10);
  });
});
