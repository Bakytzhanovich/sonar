'use client';

import type { PresetLayout, PosterLayout } from '@/lib/api';
import styles from './CaptionOverlay.module.css';

// Captions drawn over a video in the browser, so choosing a look stops being
// a guess made against a blank form.
//
// This is deliberately a second implementation of what subtitles.ts emits as
// ASS, and the usual objection applies: two implementations drift. Two things
// keep that in hand.
//
// The numbers come from the server. Sizes, colours, the overlap, how much
// larger the emphasised word is — all of it arrives in the preset catalogue,
// derived from the very constants the renderer uses. CSS holds no copy of
// them, so the two can differ in how they draw but not in what they draw.
//
// And the sizes are shares of the frame WIDTH, expressed in container-query
// width units. That is not a convenience: scaleStyleToFrame scales caption
// sizes by width too, on purpose, so libass and the browser end up agreeing
// by construction rather than by coincidence.
//
// What still differs is the outline — ASS strokes glyphs, CSS can only
// approximate with shadows — and line breaking. Hence the honest label
// wherever this is used: it is the look, not the frame-accurate render. The
// exact answer is the four-second render behind "Показать, как будет".

export interface CaptionLook {
  preset: PresetLayout;
  poster: PosterLayout;
  /** Multiplier from the size axis; 1 leaves the preset alone. */
  sizeScale: number;
  /** Overrides from the font and colour axes, empty when set to 'auto'. */
  fontFamily?: string;
  highlight?: string;
  /** 'auto' keeps the preset's own row. */
  position?: 'auto' | 'top' | 'middle' | 'bottom';
  /**
   * How big libass draws the em relative to the size it is asked for, for
   * the family in use (see assEmRatio on the server). A browser treats a font
   * size as the em; libass fits the whole ascender-to-descender height into
   * it instead, so without this every preview size is 40-70% too large.
   */
  emRatio?: number;
}

// Splits a line the way the poster layout does: the emphasised word on its
// own, the rest above and below it. The word is chosen server-side for a real
// render; here the caller passes the index, because the sample text is fixed
// and a heuristic re-implemented in the browser would be a third thing to
// keep in step.
export interface CaptionLine {
  words: string[];
  emphasis: number | null;
}

// The renderer's LINE_HEIGHT_RATIO in subtitles.ts: poster lines are placed
// 1.2 ASS sizes apart before the overlap is taken off.
const LINE_HEIGHT = 1.2;

export default function CaptionOverlay({
  line,
  look,
  topMarginRatio,
}: {
  line: CaptionLine;
  look: CaptionLook;
  /** Where top-aligned captions must start, as a share of the frame height —
   *  set when there is a headline band for them to stay clear of. */
  topMarginRatio?: number;
}) {
  const { preset, poster, sizeScale } = look;
  const family = look.fontFamily || preset.fontFamily;
  const highlight = look.highlight || preset.highlight;
  const row = !look.position || look.position === 'auto' ? preset.row : look.position;

  // Shares of the frame turned into container-query units: 1cqw is one per
  // cent of the overlay's width, and the overlay is exactly the video.
  // Two numbers per size, because libass and the browser mean different
  // things by one. `size` is the ASS size, in container units: it is what
  // libass lays lines out by — the poster layout spaces line centres by 1.2
  // of it — so line heights and overlaps are built from it. `em` is what the
  // browser needs for font-size to draw the same glyphs libass will.
  const size = preset.fontSizeRatio * sizeScale * 100;
  const em = size * (look.emRatio ?? 1);
  // Outline and shadow are in frame pixels in ASS, not in ems, so they scale
  // with the size and ignore the em ratio.
  const outline = preset.outlineRatio * sizeScale * 100;
  // Only the top row moves: the renderer pushes top-aligned captions below
  // the band and leaves every other placement alone.
  const margin =
    row === 'top' && topMarginRatio !== undefined
      ? Math.max(preset.marginRatio, topMarginRatio) * 100
      : preset.marginRatio * 100;

  // A stroke ASS draws around every glyph, approximated by four shadows.
  // Four is the compromise: eight would be smoother and is twice the paint
  // on a video that is already playing.
  const stroke =
    outline > 0
      ? `${outline}cqw 0 0 #000, -${outline}cqw 0 0 #000, 0 ${outline}cqw 0 #000, 0 -${outline}cqw 0 #000`
      : `0 ${preset.shadowRatio * 100}cqw ${preset.shadowRatio * 200}cqw rgba(0,0,0,.75)`;

  const useEmphasis = preset.poster && line.emphasis !== null;
  // How far the loud line bites into a quiet neighbour: `overlap` of the two
  // lines' average height, which is how the renderer places their centres.
  const bite = ((size + size * poster.emphasisScale) * LINE_HEIGHT * poster.overlap) / 2;
  const emphasised = useEmphasis
    ? poster.uppercase
      ? line.words[line.emphasis!].toLocaleUpperCase('ru')
      : line.words[line.emphasis!]
    : null;

  return (
    <div className={`${styles.stage} ${styles[row]}`} style={{ padding: `${margin}cqh 4cqw` }} aria-hidden="true">
      <div className={styles.block} style={{ fontFamily: `'${family}', sans-serif`, textShadow: stroke }}>
        {useEmphasis ? (
          <>
            {line.words.slice(0, line.emphasis!).length > 0 && (
              <span className={styles.quiet} style={{ fontSize: `${em}cqw`, lineHeight: `${size * LINE_HEIGHT}cqw`, color: preset.primary }}>
                {line.words.slice(0, line.emphasis!).join(' ')}
              </span>
            )}
            <span
              className={styles.loud}
              style={{
                fontSize: `${em * poster.emphasisScale}cqw`,
                lineHeight: `${size * poster.emphasisScale * LINE_HEIGHT}cqw`,
                color: highlight,
                // Negative margins are how the lines bite into each other:
                // the renderer places each line by hand because ASS line
                // spacing cannot go negative, and this is the browser's
                // equivalent of the same gesture.
                // The renderer pulls neighbouring line centres together by
                // `overlap` of their average height; a negative margin of
                // exactly that is the same gesture in CSS.
                // Only towards a line that is actually there: the renderer
                // subtracts the overlap between neighbours, so an emphasised
                // word that opens or closes the caption keeps that side.
                marginTop: line.emphasis! > 0 ? `${-bite}cqw` : undefined,
                marginBottom: line.emphasis! < line.words.length - 1 ? `${-bite}cqw` : undefined,
              }}
            >
              {emphasised}
            </span>
            {line.words.slice(line.emphasis! + 1).length > 0 && (
              <span className={styles.quiet} style={{ fontSize: `${em}cqw`, lineHeight: `${size * LINE_HEIGHT}cqw`, color: preset.primary }}>
                {line.words.slice(line.emphasis! + 1).join(' ')}
              </span>
            )}
          </>
        ) : (
          <span className={styles.single} style={{ fontSize: `${em}cqw`, color: preset.primary }}>
            {line.words.map((word, i) => (
              <span key={i} style={i === line.emphasis ? { color: highlight } : undefined}>
                {word}
                {i < line.words.length - 1 ? ' ' : ''}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
