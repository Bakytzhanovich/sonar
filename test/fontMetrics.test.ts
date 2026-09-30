import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fitFontSize, loadFontMetrics, measureAssText, measureText } from '../src/fontMetrics';

// Measured against the fonts actually committed under assets/fonts — the same
// files the Docker image hands to libass. Testing against a fixture font
// would prove the parser works and leave the question that matters, which is
// whether it works on what we ship.
const FONTS = path.join(__dirname, '..', 'assets', 'fonts');
const montserrat = () => loadFontMetrics(path.join(FONTS, 'Montserrat.ttf'));
const oswald = () => loadFontMetrics(path.join(FONTS, 'Oswald.ttf'));

describe('loadFontMetrics', () => {
  it('reads the em square of a real font', () => {
    // 1000 or 2048 are the two values in practice; anything else means the
    // head table was read at the wrong offset.
    expect([1000, 2048]).toContain(montserrat().unitsPerEm);
  });

  it('refuses a file that is not a font instead of measuring nonsense', () => {
    expect(() => loadFontMetrics(path.join(FONTS, 'README.md'))).toThrow();
  });
});

describe('measureText', () => {
  it('scales linearly with font size', () => {
    const m = montserrat();
    expect(measureText('результат', m, 100)).toBeCloseTo(measureText('результат', m, 50) * 2, 5);
  });

  it('measures a longer word as wider', () => {
    const m = montserrat();
    expect(measureText('результат', m, 64)).toBeGreaterThan(measureText('да', m, 64));
  });

  // Cyrillic is the product's main alphabet, and a font whose cmap this code
  // misread would return .notdef for all of it — which shows up as every
  // Russian word measuring exactly the same width.
  it('tells Cyrillic letters apart', () => {
    const m = montserrat();
    expect(measureText('ш', m, 64)).not.toBeCloseTo(measureText('і', m, 64), 1);
  });

  it('measures Kazakh letters outside the Russian alphabet', () => {
    const m = montserrat();
    // Non-zero means the glyph was found; ә, ң and ұ are the ones a
    // Russian-only subset would be missing.
    expect(measureText('әңұқғ', m, 64)).toBeGreaterThan(0);
  });

  it('is empty for an empty string', () => {
    expect(measureText('', montserrat(), 64)).toBe(0);
  });

  // The whole point of reading real metrics rather than counting characters:
  // a condensed family is narrower at the same size, and Oswald is the one
  // that exists in our catalogue precisely because it fits more words.
  it('makes a condensed family narrower than a neutral one at the same size', () => {
    const text = 'результат';
    expect(measureText(text, oswald(), 64)).toBeLessThan(measureText(text, montserrat(), 64));
  });
});

describe('fitFontSize', () => {
  it('returns a size whose text actually fits the width', () => {
    const m = montserrat();
    const size = fitFontSize('МОНТАЖЕРОВ', m, 1000, 200, 20);
    expect(measureText('МОНТАЖЕРОВ', m, size)).toBeLessThanOrEqual(1000);
  });

  it('does not grow past the cap when there is room to spare', () => {
    expect(fitFontSize('да', montserrat(), 5000, 120, 20)).toBe(120);
  });

  // A caption slightly too wide is recoverable; a render that threw in the
  // middle of the subtitles stage is not.
  it('bottoms out at the floor instead of failing on an impossible line', () => {
    const size = fitFontSize('невероятнодлинноесловокотороенивлезет', montserrat(), 50, 120, 24);
    expect(size).toBe(24);
  });
});

describe('assEmRatio', () => {
  // Read from the OS/2 table of the files we actually ship. libass fits the
  // whole of winAscent+winDescent into the requested size, so the em comes
  // out well short of it — for Oswald, 0.588.
  it('reads how small libass draws the em for each family we ship', () => {
    expect(loadFontMetrics(path.join(FONTS, 'Oswald.ttf')).assEmRatio).toBeCloseTo(0.588, 3);
    expect(loadFontMetrics(path.join(FONTS, 'Montserrat.ttf')).assEmRatio).toBeCloseTo(0.640, 3);
  });

  it('is below one for every shipped face, which is the whole trap', () => {
    for (const file of ['Montserrat.ttf', 'Oswald.ttf', 'PlayfairDisplay.ttf', 'Unbounded.ttf']) {
      const ratio = loadFontMetrics(path.join(FONTS, file)).assEmRatio;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(1);
    }
  });
});

describe('measureAssText', () => {
  // The number this is pinned to came from a real render: "Как я поднял 2"
  // in Oswald at ASS size 118 was measured at 386px wide in the finished
  // frame. Treating 118 as the em predicts 673px — off by three quarters.
  it('predicts the width libass actually draws, not the em-based one', () => {
    const width = measureAssText('Как я поднял 2', oswald(), 118);
    expect(width).toBeGreaterThanOrEqual(386);
    // Kerning is ignored on purpose, so a small overestimate is expected; a
    // large one would mean the ratio is wrong again.
    expect(width).toBeLessThan(386 * 1.06);
  });
});
