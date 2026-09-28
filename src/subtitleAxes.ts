import { rgbToAss } from './assColour';
import { HEADLINE_FONTS } from './headlineStyles';
import type { SubtitleStyle } from './subtitles';

export { rgbToAss };

// The three things about a caption that people want to change independently
// of its look: the typeface, the colour of the word being emphasised, and how
// big the whole thing is.
//
// Until now these were baked into the five presets, which meant "Крупный, but
// mint" was not a thing anyone could ask for — it would have taken a sixth
// preset, and then a seventh for "Крупный but turquoise". Presets still exist
// and still decide the things that genuinely travel together (outline versus
// shadow, the poster layout, where the block sits); these three ride on top.
//
// 'auto' throughout means "whatever the preset already said", which is what
// keeps every job rendered before today looking exactly as it did. Same
// convention as subtitlePositions.ts, for the same reason.

export interface SubtitleColour {
  id: string;
  label: string;
  description: string;
  hex: string;
}

// Named for what they look like rather than for their hue. "Янтарь" reads as
// a choice someone made; "Жёлтый" reads as a value in a colour picker, and
// the list stops feeling like part of the product.
export const SUBTITLE_COLOURS: SubtitleColour[] = [
  { id: 'auto', label: 'Как в стиле', description: 'Цвет, который стиль задаёт сам', hex: '' },
  { id: 'amber', label: 'Янтарь', description: 'Тёплый жёлтый — самый заметный на видео', hex: '#FACC15' },
  { id: 'azure', label: 'Лазурь', description: 'Холодный синий, спокойный', hex: '#38BDF8' },
  { id: 'lime', label: 'Лайм', description: 'Кислотный зелёный, для энергичного', hex: '#A3E635' },
  { id: 'crimson', label: 'Багровый', description: 'Красный — тревога и срочность', hex: '#F43F5E' },
  { id: 'pearl', label: 'Жемчуг', description: 'Белый — когда цвет не нужен вовсе', hex: '#FFFFFF' },
  { id: 'turquoise', label: 'Бирюза', description: 'Зелёно-голубой, мягкий акцент', hex: '#2DD4BF' },
];

export interface SubtitleSize {
  id: string;
  label: string;
  description: string;
  /** Multiplier on whatever size the preset chose, so each preset keeps its
   *  own proportions instead of every style collapsing to one number. */
  scale: number;
}

export const SUBTITLE_SIZES: SubtitleSize[] = [
  { id: 'small', label: 'Мелкий', description: 'Не перекрывает лицо', scale: 0.8 },
  { id: 'medium', label: 'Средний', description: 'Как задумано в стиле', scale: 1 },
  { id: 'large', label: 'Крупный', description: 'Читается в ленте на ходу', scale: 1.25 },
];

// The caption typefaces are the same files the headlines use — there is one
// assets/fonts, and a family offered here but absent there would be a family
// libass silently replaces.
export const SUBTITLE_FONTS = [
  { id: 'auto', label: 'Как в стиле', description: 'Шрифт, который стиль задаёт сам', family: '' },
  ...HEADLINE_FONTS.map(({ id, label, description, family }) => ({ id, label, description, family })),
];

export const DEFAULT_SUBTITLE_FONT = 'auto';
export const DEFAULT_SUBTITLE_COLOUR = 'auto';
export const DEFAULT_SUBTITLE_SIZE = 'medium';

export function isSubtitleFontId(value: unknown): value is string {
  return typeof value === 'string' && SUBTITLE_FONTS.some((f) => f.id === value);
}

export function isSubtitleColourId(value: unknown): value is string {
  return typeof value === 'string' && SUBTITLE_COLOURS.some((c) => c.id === value);
}

export function isSubtitleSizeId(value: unknown): value is string {
  return typeof value === 'string' && SUBTITLE_SIZES.some((s) => s.id === value);
}

/**
 * Lays the three axes over a preset's style.
 *
 * Applied before scaleStyleToFrame, not after: the sizes here are written
 * against the reference frame like every other number in a preset, and a
 * multiplier applied after scaling would compound with it.
 *
 * An unknown id falls through to the preset's own value rather than throwing.
 * It can only come from a stale client or an older row, and a caption is not
 * worth failing a finished transcription over.
 */
export function applySubtitleAxes(
  style: SubtitleStyle,
  axes: { font?: string | null; colour?: string | null; size?: string | null }
): SubtitleStyle {
  const font = SUBTITLE_FONTS.find((f) => f.id === axes.font);
  const colour = SUBTITLE_COLOURS.find((c) => c.id === axes.colour);
  const size = SUBTITLE_SIZES.find((s) => s.id === axes.size);

  const next = { ...style };
  if (font?.family) next.fontName = font.family;
  if (colour?.hex) next.highlightColour = rgbToAss(colour.hex);
  if (size && size.scale !== 1) {
    next.fontSize = Math.round(style.fontSize * size.scale);
    // The outline is the text's own geometry: left at its original width
    // under a larger font it stops separating the letters from a bright
    // frame, which is the one thing it is there for. Same reasoning as
    // scaleStyleToFrame, and skipped entirely for the poster style, whose
    // outline is deliberately zero.
    next.outline = Math.round(style.outline * size.scale * 10) / 10;
  }
  return next;
}
