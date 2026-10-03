import { describe, it, expect } from 'vitest';
import { count, plural } from '../src/plural';

describe('plural', () => {
  const forms: [string, string, string] = ['публикация', 'публикации', 'публикаций'];
  it('picks the Russian form for the count', () => {
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => count(n, forms))).toEqual([
      '0 публикаций', '1 публикация', '2 публикации', '4 публикации', '5 публикаций',
      '11 публикаций', '12 публикаций', '14 публикаций', '21 публикация', '22 публикации',
      '25 публикаций', '101 публикация', '111 публикаций',
    ]);
    expect(plural(1, ['сегмент найден', 'сегмента найдено', 'сегментов найдено'])).toBe('сегмент найден');
  });
});
