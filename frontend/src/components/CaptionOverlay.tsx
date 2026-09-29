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

export default function CaptionOverlay({ line, look }: { line: CaptionLine; look: CaptionLook }) {
  const { preset, poster, sizeScale } = look;
  const family = look.fontFamily || preset.fontFamily;
  const highlight = look.highlight || preset.highlight;
  const row = !look.position || look.position === 'auto' ? preset.row : look.position;

  // Shares of the frame turned into container-query units: 1cqw is one per
  // cent of the overlay's width, and the overlay is exactly the video.
  const base = preset.fontSizeRatio * sizeScale * 100;
  const outline = preset.outlineRatio * sizeScale * 100;
  const margin = preset.marginRatio * 100;

  // A stroke ASS draws around every glyph, approximated by four shadows.
  // Four is the compromise: eight would be smoother and is twice the paint
  // on a video that is already playing.
  const stroke =
    outline > 0
      ? `${outline}cqw 0 0 #000, -${outline}cqw 0 0 #000, 0 ${outline}cqw 0 #000, 0 -${outline}cqw 0 #000`
      : `0 ${preset.shadowRatio * 100}cqw ${preset.shadowRatio * 200}cqw rgba(0,0,0,.75)`;

  const useEmphasis = preset.poster && line.emphasis !== null;
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
              <span className={styles.quiet} style={{ fontSize: `${base}cqw`, color: preset.primary }}>
                {line.words.slice(0, line.emphasis!).join(' ')}
              </span>
            )}
            <span
              className={styles.loud}
              style={{
                fontSize: `${base * poster.emphasisScale}cqw`,
                color: highlight,
                // Negative margins are how the lines bite into each other:
                // the renderer places each line by hand because ASS line
                // spacing cannot go negative, and this is the browser's
                // equivalent of the same gesture.
                marginTop: `${-base * poster.emphasisScale * poster.overlap * 0.6}cqw`,
                marginBottom: `${-base * poster.emphasisScale * poster.overlap * 0.6}cqw`,
              }}
            >
              {emphasised}
            </span>
            {line.words.slice(line.emphasis! + 1).length > 0 && (
              <span className={styles.quiet} style={{ fontSize: `${base}cqw`, color: preset.primary }}>
                {line.words.slice(line.emphasis! + 1).join(' ')}
              </span>
            )}
          </>
        ) : (
          <span className={styles.single} style={{ fontSize: `${base}cqw`, color: preset.primary }}>
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
