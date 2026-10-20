import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from './subtitles';
import { rgbToAss } from './assColour';

// Ready-made caption looks, rather than exposing the dozen knobs a
// SubtitleStyle actually has. Font size, outline width and vertical margin
// are not independent choices: raise the size without the outline and the
// text stops being readable over a bright frame, move it up without checking
// the margin and it collides with the safe area platforms reserve for their
// own UI. A preset is a combination someone has already checked.
//
// Colours are ASS &HAABBGGRR — alpha, then BLUE-GREEN-RED. Writing them in
// the RRGGBB order everyone expects produces the wrong colour silently.

export type SubtitlePresetId = 'classic' | 'bold' | 'lower' | 'minimal' | 'accent' | 'poster' | 'dynamic' | 'slam' | 'topic';

export interface SubtitlePreset {
  id: SubtitlePresetId;
  label: string;
  description: string;
  /** A word shown on the chip. Only worth setting on something genuinely new
   *  — a list where everything is flagged flags nothing. */
  badge?: string;
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
      // over the lower fifth of the frame — 384 of 1920. This claimed to
      // clear it at 340, which is INSIDE that band, not above it; a client
      // watching the live preview is what caught it. 430 leaves a real gap
      // above the reserved zone; 60, the ASS default, puts the text under
      // their UI entirely.
      marginV: 430,
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
  {
    id: 'poster',
    label: 'Плакат',
    description: 'Ключевое слово крупно и цветом, строки внахлёст',
    badge: 'NEW',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      // The quiet lines. The shouted word is derived from this by
      // emphasisScale, so this is the size of the words AROUND it, not of
      // the caption — which is why it is smaller than the classic 64.
      fontSize: 52,
      // No outline, which is what separates this look from a subtitle track.
      // The shadow does the separating instead: an outline traces every
      // letter and reads as a caption, a shadow sits behind the block and
      // reads as type set on the picture.
      outline: 0,
      shadow: 4,
      // Dead centre. The look puts the block over the speaker rather than
      // under them; a user who wants it elsewhere still has the position
      // control, which this style honours.
      alignment: 5,
    },
  },
  {
    id: 'dynamic',
    label: 'Динамика',
    description: 'Слова появляются по одному, ключевое — крупно и жёлтым',
    badge: 'NEW',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      fontSize: 60,
      // Near-white and lemon, not pure: the colours of the look this is
      // modelled on, and a pure white glares against a bright frame.
      primaryColour: rgbToAss('#FCFCFC'),
      highlightColour: rgbToAss('#F4EC04'),
      // A soft shadow and no outline, like the poster: type set on the
      // picture rather than a subtitle track.
      outline: 0,
      shadow: 3,
      // At chest level, under the face: bottom-anchored, well up from the
      // edge. The position control still moves it.
      alignment: 2,
      marginV: 600,
    },
  },
  {
    id: 'slam',
    label: 'Удар',
    description: 'Одно огромное слово за раз, резкая смена',
    badge: 'NEW',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      // Fixed and huge: an ordinary word fills most of a 1080-wide frame,
      // and a long one is meant to run off it.
      fontSize: 300,
      primaryColour: rgbToAss('#AC0414'),
      highlightColour: rgbToAss('#AC0414'),
      // No outline, no shadow: a flat red word on the picture.
      outline: 0,
      shadow: 0,
      alignment: 5,
    },
  },
  {
    id: 'topic',
    label: 'Тема',
    description: 'Слово темы сверху, субтитры в две строки',
    badge: 'NEW',
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      // The key line's size; the lead-in, the topic word and the accent are
      // all derived from it (topicLayout.ts). A little over the reference's
      // 80: condensed capitals read smaller than their size on a phone.
      fontSize: 96,
      primaryColour: rgbToAss('#ECE4DC'),
      highlightColour: rgbToAss('#8C141C'),
      outline: 0,
      shadow: 2,
      // The lower third: the key line's bottom this far above the frame's.
      alignment: 2,
      marginV: 300,
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
