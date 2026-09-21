import type { SubtitleStyle } from './subtitles';

// Where the captions sit, as a choice of its own.
//
// Separate from subtitlePresets.ts because these are two different questions.
// A preset answers "what do the captions look like" — colour, weight, outline.
// This answers "where in the frame do they go", and a blogger wants to decide
// both: the same look belongs over the face on one clip and under it on the
// next, depending on what the shot is doing.
//
// Position is never only an alignment. Reels, Shorts and TikTok all draw their
// own controls, caption and handle over the bottom of the frame, and a header
// over the top. Moving text into either without also moving the margin puts it
// under someone else's interface, where it is unreadable and we cannot see it
// from here. So each position carries the margin that clears that band, and
// neither is offered without the other.

export type SubtitlePositionId = 'auto' | 'top' | 'center' | 'bottom';

export interface SubtitlePosition {
  id: SubtitlePositionId;
  label: string;
  description: string;
  // Null for 'auto', which is the absence of an override rather than a
  // position of its own. libass alignment is numpad-shaped: 2 is bottom
  // centre, 5 dead centre, 8 top centre.
  alignment: number | null;
  marginV: number | null;
}

export const SUBTITLE_POSITIONS: SubtitlePosition[] = [
  {
    id: 'auto',
    label: 'Как в стиле',
    description: 'Там, где её ставит выбранный стиль',
    alignment: null,
    marginV: null,
  },
  {
    id: 'top',
    label: 'Сверху',
    description: 'Под шапкой платформы, над лицом',
    alignment: 8,
    // The top band carries the account name and the platform's own header,
    // and on a phone the notch sits above that. 260 of 1920 clears all of it.
    marginV: 260,
  },
  {
    id: 'center',
    label: 'По центру',
    description: 'Посреди кадра, поверх лица',
    alignment: 5,
    // At dead centre the margin has almost nothing to do — libass measures it
    // from the edge, and the text is nowhere near one. Kept at the default so
    // the value is not silently something else.
    marginV: 60,
  },
  {
    id: 'bottom',
    label: 'Снизу',
    description: 'Выше кнопок Reels и Shorts',
    alignment: 2,
    // The same 340 the 'lower' preset was already using — a value that had
    // been checked against the lower fifth those platforms reserve.
    marginV: 340,
  },
];

export const DEFAULT_SUBTITLE_POSITION: SubtitlePositionId = 'auto';

/**
 * Puts a style where the position asks for, leaving everything else alone.
 *
 * 'auto' returns the style untouched, and that is what keeps the older
 * 'Снизу' preset meaningful: it positions itself, and a blogger who picked it
 * without touching this control still gets what they picked. An explicit
 * choice wins over the preset, because it is the more recent thing the person
 * said.
 */
export function applyPosition(style: SubtitleStyle, id: string | null | undefined): SubtitleStyle {
  const position = SUBTITLE_POSITIONS.find((p) => p.id === id);
  // An unknown id can only come from an older row or a hand-made request, and
  // "leave it where the style puts it" is a valid answer to that.
  if (!position || position.alignment === null || position.marginV === null) return style;
  return { ...style, alignment: position.alignment, marginV: position.marginV };
}

export function isSubtitlePositionId(value: unknown): value is SubtitlePositionId {
  return typeof value === 'string' && SUBTITLE_POSITIONS.some((p) => p.id === value);
}
