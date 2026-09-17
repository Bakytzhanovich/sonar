import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from './subtitles';

// Ready-made caption looks, rather than exposing the dozen knobs a
// SubtitleStyle actually has. Font size, outline width and vertical margin
// are not independent choices: raise the size without the outline and the
// text stops being readable over a bright frame, move it up without checking
// the margin and it collides with the safe area platforms reserve for their
// own UI. A preset is a combination someone has already checked.
//
// Colours are ASS &HAABBGGRR — alpha, then BLUE-GREEN-RED. Writing them in
// the RRGGBB order everyone expects produces the wrong colour silently.

export type SubtitlePresetId = 'classic' | 'bold' | 'lower' | 'minimal' | 'accent';

export interface SubtitlePreset {
  id: SubtitlePresetId;
  label: string;
  description: string;
  style: SubtitleStyle;
}

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  {
    id: 'classic',
    label: 'Классика',
    description: 'Белый текст, жёлтая подсветка слова',
    style: DEFAULT_SUBTITLE_STYLE,
  },
  {
    id: 'bold',
    label: 'Крупный',
    description: 'Больше кегль, по центру кадра',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontSize: 82,
      // The outline grows with the size: a heavier letterform over a bright
      // frame needs more separation, not the same 3px.
      outline: 5,
    },
  },
  {
    id: 'lower',
    label: 'Снизу',
    description: 'Под лицом, выше кнопок Reels и Shorts',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      // Alignment 2 is bottom-centre, and only then does marginV mean
      // "distance from the bottom" — with the default 5 (dead centre) the
      // margin barely moves anything, so a preset that set it and nothing
      // else would silently look identical to the default.
      alignment: 2,
      // Reels, Shorts and TikTok all draw their own controls and caption
      // over the lower fifth of the frame. 340 of 1920 clears that; 60,
      // which is the ASS default, puts the text under their UI.
      marginV: 340,
    },
  },
  {
    id: 'minimal',
    label: 'Минимал',
    description: 'Без подсветки, тонкий контур',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontSize: 58,
      // Same colour for both means the karaoke highlight still tracks the
      // voice in timing, but stops changing colour — the quiet look.
      highlightColour: '&H00FFFFFF',
      outline: 2,
      shadow: 0,
    },
  },
  {
    id: 'accent',
    label: 'Акцент',
    description: 'Подсветка фирменным цветом Sonar',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      // rose-700 (#be123c) as BGR: 3C12BE.
      highlightColour: '&H003C12BE',
      outline: 4,
    },
  },
];

export const DEFAULT_SUBTITLE_PRESET: SubtitlePresetId = 'classic';

export function styleForPreset(id: string | null | undefined): SubtitleStyle {
  const preset = SUBTITLE_PRESETS.find((p) => p.id === id);
  // An unknown id is not worth failing a render over — it can only come from
  // an older row or a hand-made request, and the default is a valid answer.
  return preset ? preset.style : DEFAULT_SUBTITLE_STYLE;
}

export function isSubtitlePresetId(value: unknown): value is SubtitlePresetId {
  return typeof value === 'string' && SUBTITLE_PRESETS.some((p) => p.id === value);
}
