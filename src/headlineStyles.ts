import { rgbToAss } from './assColour';
// The three things a person gets to choose about a headline: typeface, size
// and colour.
//
// Closed lists, not free input, and each for its own reason.
//
// FONT, because libass substitutes a missing family silently — no warning, no
// log line, just somebody else's typography in a finished client video. The
// list is exactly what ships in assets/fonts/ and is handed to ffmpeg through
// `fontsdir`, so what the picker offers is what the renderer has, on every
// machine. Adding a font means adding a file, not asking a person to install
// one.
//
// SIZE, because a headline has a band to fit in and an exact number invites
// one that does not. These are starting points; the builder still steps down
// when the text needs a third line.
//
// COLOUR, because the band is black and half the colour space is unreadable on
// it. These are the ones that hold up, and each is written in ASS's own
// &HAABBGGRR order — alpha, then BLUE-GREEN-RED — which is reversed from the
// RRGGBB everyone expects and wrong silently when confused.

export type HeadlineFontId = 'montserrat' | 'oswald' | 'unbounded' | 'playfair';
export type HeadlineSizeId = 'small' | 'medium' | 'large';
export type HeadlineColourId = 'white' | 'yellow' | 'mint' | 'red';

export interface HeadlineFont {
  id: HeadlineFontId;
  label: string;
  description: string;
  /** The family name inside the file, which is not always the file's name. */
  family: string;
}

export const HEADLINE_FONTS: HeadlineFont[] = [
  { id: 'montserrat', label: 'Montserrat', description: 'Нейтральный, для любого ролика', family: 'Montserrat' },
  { id: 'oswald', label: 'Oswald', description: 'Узкий — влезает больше слов', family: 'Oswald' },
  { id: 'unbounded', label: 'Unbounded', description: 'Широкий и заметный', family: 'Unbounded' },
  { id: 'playfair', label: 'Playfair Display', description: 'С засечками, для серьёзной темы', family: 'Playfair Display' },
];

export const DEFAULT_HEADLINE_FONT: HeadlineFontId = 'montserrat';

export interface HeadlineSize {
  id: HeadlineSizeId;
  label: string;
  description: string;
  /** Size for one or two lines. The builder shrinks it for a third. */
  fontSize: number;
}

export const HEADLINE_SIZES: HeadlineSize[] = [
  { id: 'small', label: 'Мелкий', description: 'Не перетягивает внимание с видео', fontSize: 74 },
  { id: 'medium', label: 'Средний', description: 'По умолчанию', fontSize: 96 },
  { id: 'large', label: 'Крупный', description: 'Читается в ленте на ходу', fontSize: 118 },
];

export const DEFAULT_HEADLINE_SIZE: HeadlineSizeId = 'medium';

export interface HeadlineColour {
  /** The colour as written; `colour` below is this converted for ASS. */
  hex: string;
  id: HeadlineColourId;
  label: string;
  description: string;
  /** &HAABBGGRR — alpha, then BLUE-GREEN-RED. */
  colour: string;
}

// Written as the hex everybody reads and converted once, rather than as the
// BGR strings that used to sit here with a comment above each explaining what
// colour it really was. The comments were the tell: a value nobody can read
// without a note is a value nobody can check.
export const HEADLINE_COLOURS: HeadlineColour[] = [
  { id: 'white' as const, label: 'Белый', description: 'Максимальный контраст на чёрном', hex: '#FFFFFF' },
  { id: 'yellow' as const, label: 'Жёлтый', description: 'Тот самый цвет кликбейта', hex: '#FACC15' },
  { id: 'mint' as const, label: 'Мятный', description: 'Спокойный акцент', hex: '#34D399' },
  { id: 'red' as const, label: 'Красный', description: 'Тревога, срочность', hex: '#EF4444' },
].map((colour) => ({ ...colour, colour: rgbToAss(colour.hex) }));

export const DEFAULT_HEADLINE_COLOUR: HeadlineColourId = 'white';

export function headlineFont(id: string | null | undefined): HeadlineFont {
  // An unknown id can only come from an older row or a hand-made request, and
  // the default is a valid answer — not a reason to fail somebody's render.
  return HEADLINE_FONTS.find((f) => f.id === id) ?? HEADLINE_FONTS[0];
}

export function headlineSize(id: string | null | undefined): HeadlineSize {
  return HEADLINE_SIZES.find((s) => s.id === id) ?? HEADLINE_SIZES[1];
}

export function headlineColour(id: string | null | undefined): HeadlineColour {
  return HEADLINE_COLOURS.find((c) => c.id === id) ?? HEADLINE_COLOURS[0];
}

export function isHeadlineFontId(v: unknown): v is HeadlineFontId {
  return typeof v === 'string' && HEADLINE_FONTS.some((f) => f.id === v);
}
export function isHeadlineSizeId(v: unknown): v is HeadlineSizeId {
  return typeof v === 'string' && HEADLINE_SIZES.some((s) => s.id === v);
}
export function isHeadlineColourId(v: unknown): v is HeadlineColourId {
  return typeof v === 'string' && HEADLINE_COLOURS.some((c) => c.id === v);
}
