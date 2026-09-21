import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  HEADLINE_COLOURS,
  HEADLINE_FONTS,
  HEADLINE_SIZES,
  headlineColour,
  headlineFont,
  headlineSize,
  isHeadlineColourId,
  isHeadlineFontId,
  isHeadlineSizeId,
} from '../src/headlineStyles';
import { buildHeadlineAss, headlineStyleFor } from '../src/headline';

const FONTS_DIR = path.resolve(__dirname, '..', 'assets', 'fonts');

describe('bundled fonts', () => {
  it('ships a file for every font the picker offers', () => {
    // THE test in this file. libass answers a missing family by silently
    // choosing another one, so a font in the list with no file behind it does
    // not fail a render — it renders a client's video in the wrong typeface,
    // and nobody finds out until they watch it. Verdana stood in for
    // Montserrat for days exactly this way.
    const files = readdirSync(FONTS_DIR).filter((f) => f.endsWith('.ttf'));
    expect(files.length).toBeGreaterThanOrEqual(HEADLINE_FONTS.length);

    // Compared with spaces stripped: the family inside the file carries them
    // ("Playfair Display") and the filename does not.
    const stems = files.map((f) => f.replace(/\.ttf$/, '').toLowerCase());
    for (const font of HEADLINE_FONTS) {
      expect(stems, `нет файла для ${font.family}`).toContain(font.family.replace(/\s+/g, '').toLowerCase());
    }
  });

  it('ships the licence each font is redistributed under', () => {
    // OFL permits bundling and requires the licence to travel with the copy.
    const files = readdirSync(FONTS_DIR);
    for (const font of HEADLINE_FONTS) {
      const stem = font.family.replace(/\s+/g, '');
      expect(files, `нет лицензии для ${font.family}`).toContain(`${stem}.OFL.txt`);
    }
  });
});

describe('catalogue lookups', () => {
  it('falls back to a default rather than failing a render', () => {
    // These ids reach here from rows written by older code and from hand-made
    // requests. Neither is worth losing somebody's render over.
    expect(headlineFont('nonsense').id).toBe('montserrat');
    expect(headlineSize(null).id).toBe('medium');
    expect(headlineColour(undefined).id).toBe('white');
  });

  it('recognises its own ids and nothing else', () => {
    expect(isHeadlineFontId('oswald')).toBe(true);
    expect(isHeadlineFontId('comic-sans')).toBe(false);
    expect(isHeadlineSizeId('large')).toBe(true);
    expect(isHeadlineColourId('mint')).toBe(true);
    expect(isHeadlineColourId('#ff0000')).toBe(false);
  });

  it('writes every colour in ASS byte order, not RRGGBB', () => {
    // &HAABBGGRR — alpha, then BLUE-GREEN-RED. Writing one the way it is
    // spelled everywhere else swaps red and blue and is wrong in silence.
    for (const c of HEADLINE_COLOURS) {
      expect(c.colour, c.id).toMatch(/^&H[0-9A-F]{8}$/);
    }
  });

  it('orders the sizes smallest to largest, as the labels promise', () => {
    const sizes = HEADLINE_SIZES.map((s) => s.fontSize);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });
});

describe('headlineStyleFor', () => {
  it('applies the chosen font, size and colour together', () => {
    const style = headlineStyleFor({ font: 'oswald', size: 'large', colour: 'yellow' });
    expect(style.fontName).toBe('Oswald');
    expect(style.fontSize).toBe(118);
    expect(style.primaryColour).toBe('&H0015CCFA');
  });

  it('keeps the third-line step below the chosen size', () => {
    // The small size is derived, not chosen: a headline that needs a third
    // line still has to fit the band, whatever size was asked for.
    for (const size of HEADLINE_SIZES) {
      const style = headlineStyleFor({ size: size.id });
      expect(style.fontSizeSmall, size.id).toBeLessThan(style.fontSize);
    }
  });

  it('reaches the generated .ass', () => {
    const ass = buildHeadlineAss('Выиграл', headlineStyleFor({ font: 'playfair', colour: 'red' }))!;
    expect(ass).toContain('Playfair Display');
    expect(ass).toContain('&H004444EF');
  });
});
