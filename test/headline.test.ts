import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HEADLINE_STYLE,
  HEADLINE_BAND_HEIGHT,
  HEADLINE_MAX_CHARS,
  buildHeadlineAss,
  clearOfHeadline,
  sanitizeHeadline,
  wrapHeadline,
} from '../src/headline';

describe('sanitizeHeadline', () => {
  it('strips the braces and backslashes ASS uses for override blocks', () => {
    // Left in, these end the event's text and start a tag block, so a headline
    // could set arbitrary render options — position, colour, transparency.
    expect(sanitizeHeadline('ХАЙП {\\pos(0,0)\\alpha&HFF&}')).toBe('ХАЙП pos(0,0)alpha&HFF&');
  });

  it('flattens newlines, which would otherwise end the event early', () => {
    expect(sanitizeHeadline('ПЕРВАЯ\nВТОРАЯ')).toBe('ПЕРВАЯ ВТОРАЯ');
  });

  it('caps at what three lines can hold', () => {
    expect(sanitizeHeadline('А'.repeat(200))).toHaveLength(HEADLINE_MAX_CHARS);
  });

  it('treats whitespace as no headline at all', () => {
    expect(sanitizeHeadline('   ')).toBe('');
  });
});

describe('wrapHeadline', () => {
  it('evens the lines out instead of packing the first one full', () => {
    // Greedy alone produced "КАК Я ПОДНЯЛ 2 / МЛН", breaking between a number
    // and its unit. Balanced wrapping keeps them together.
    expect(wrapHeadline('КАК Я ПОДНЯЛ 2 МЛН')).toEqual(['КАК Я ПОДНЯЛ', '2 МЛН']);
  });

  // The real one from a render: balancing alone still broke "2 / млн",
  // because it only chooses widths and knows nothing about what a number is.
  it('never leaves a number at the end of a line apart from the word it counts', () => {
    for (const text of ['Как я поднял 2 млн за месяц', 'Мой доход вырос в 3 раза за год', 'Похудела на 12 кг без диет и спортзала']) {
      const lines = wrapHeadline(text);
      expect(lines.join(' ')).toBe(text);
      for (const line of lines.slice(0, -1)) expect(line).not.toMatch(/\d$/);
    }
  });

  it('does not leave a one-letter preposition hanging at the end of a line', () => {
    for (const text of ['Как зарабатывать в соцсетях без вложений', 'Секреты продаж в директе и в сторис']) {
      for (const line of wrapHeadline(text).slice(0, -1)) expect(line).not.toMatch(/(^|\s)[вискоуа]$/i);
    }
  });

  it('keeps a short headline on one line', () => {
    expect(wrapHeadline('БРОСЬ РАБОТУ')).toEqual(['БРОСЬ РАБОТУ']);
  });

  it('never exceeds three lines', () => {
    expect(wrapHeadline('А'.repeat(HEADLINE_MAX_CHARS).split('').join(' ')).length).toBeLessThanOrEqual(3);
  });

  it('gives an over-long word its own line rather than cutting it', () => {
    // A hyphenated fragment of a Russian word reads as a bug; an over-wide
    // line reads as a long word.
    expect(wrapHeadline('ЭКСПЕРИМЕНТИРОВАНИЕ')).toEqual(['ЭКСПЕРИМЕНТИРОВАНИЕ']);
  });
});

describe('buildHeadlineAss', () => {
  it('returns null for an empty headline, so no band is reserved', () => {
    expect(buildHeadlineAss('')).toBeNull();
    expect(buildHeadlineAss('   ')).toBeNull();
  });

  it('draws the text and nothing else', () => {
    const ass = buildHeadlineAss('БРОСЬ РАБОТУ')!;
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(events).toHaveLength(1);
    expect(ass).toContain('БРОСЬ РАБОТУ');
    // \p1 is ASS drawing mode. There are no drawings any more — the bracket
    // frame was removed, and a stray one would be decoration nobody asked for.
    expect(events.filter((e) => e.includes('\\p1'))).toHaveLength(0);
  });

  it('shrinks the font when the headline needs a third line', () => {
    const two = buildHeadlineAss('БРОСЬ РАБОТУ ПРЯМО СЕЙЧАС')!;
    const three = buildHeadlineAss('ПОЧЕМУ НИКТО НЕ ГОВОРИТ ОБ ЭТОМ СПОСОБЕ')!;
    const size = (ass: string) => Number(ass.match(/Style: Headline,[^,]+,(\d+)/)![1]);
    expect(size(three)).toBeLessThan(size(two));
  });

  it('outlines the letters only when they sit over the picture', () => {
    // Over the picture, white letters on a white wall vanish without a
    // stroke; over plain black a stroke only thickens them.
    const outlineAndShadow = (ass: string) => {
      const fields = ass.match(/Style: Headline,.*$/m)![0].split(',');
      // Outline and Shadow are the 17th and 18th fields of the Format line.
      return [Number(fields[16]), Number(fields[17])];
    };
    const overBlack = buildHeadlineAss('ТЕКСТ', { ...DEFAULT_HEADLINE_STYLE, overPicture: false })!;
    const overPicture = buildHeadlineAss('ТЕКСТ', { ...DEFAULT_HEADLINE_STYLE, overPicture: true })!;
    expect(outlineAndShadow(overBlack)).toEqual([0, 0]);
    const [outline, shadow] = outlineAndShadow(overPicture);
    expect(outline).toBeGreaterThan(0);
    expect(shadow).toBeGreaterThan(0);
  });

  it('holds the headline for the whole clip', () => {
    // No duration is threaded down here, so the event has to outlast any
    // source we accept.
    expect(buildHeadlineAss('ТЕКСТ')!).toContain('0:00:00.00,9:59:59.99');
  });
});

describe('clearOfHeadline', () => {
  const top = { alignment: 8, marginV: 260 };

  it('pushes top captions below the band', () => {
    // Both measure from the top edge, so without this they occupy the same
    // strip — visible only once someone watches the finished render.
    expect(clearOfHeadline(top, 'ЗАГОЛОВОК').marginV).toBeGreaterThan(HEADLINE_BAND_HEIGHT);
  });

  it('leaves them alone when there is no headline', () => {
    expect(clearOfHeadline(top, null)).toEqual(top);
    expect(clearOfHeadline(top, '   ')).toEqual(top);
  });

  it.each([
    ['centre', 5],
    ['bottom', 2],
  ])('leaves %s captions alone — the band does not reach them', (_label, alignment) => {
    const style = { alignment, marginV: 340 };
    expect(clearOfHeadline(style, 'ЗАГОЛОВОК')).toEqual(style);
  });

  it('does not pull a caption that already clears the band upwards', () => {
    const low = { alignment: 8, marginV: 900 };
    expect(clearOfHeadline(low, 'ЗАГОЛОВОК')).toEqual(low);
  });
});
