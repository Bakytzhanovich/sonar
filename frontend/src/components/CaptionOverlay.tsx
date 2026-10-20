'use client';

import { Fragment, useEffect, useState } from 'react';
import type { DynamicLayout, PresetLayout, PosterLayout } from '@/lib/api';
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
  /** The renderer's numbers for "Динамика", from the catalogue. */
  dynamic?: DynamicLayout;
  /** Multiplier from the size axis; 1 leaves the preset alone. */
  sizeScale: number;
  /** Overrides from the font and colour axes, empty when set to 'auto'. */
  fontFamily?: string;
  highlight?: string;
  /**
   * The chosen position, straight from the catalogue. Both halves matter: a
   * position is never only an alignment — each carries the margin that clears
   * the platform's own interface, and using the preset's margin instead puts
   * "Сверху" under a header in the preview that it clears in the render.
   *
   * Null row means 'auto', which defers to the preset entirely.
   */
  position?: { row: 'top' | 'middle' | 'bottom' | null; marginRatio: number | null } | null;
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
  focused = false,
  anchorRatio = 0.44,
}: {
  line: CaptionLine;
  look: CaptionLook;
  /** Where top-aligned captions must start, as a share of the frame height —
   *  set when there is a headline band for them to stay clear of. */
  topMarginRatio?: number;
  /** Outlined: the thing the settings below are currently changing. */
  focused?: boolean;
  /** Where "Удар" puts its word, as a share of the frame height — the
   *  renderer's wordAnchorY, which depends on where the picture sits. */
  anchorRatio?: number;
}) {
  const { preset, poster, sizeScale } = look;
  const dynamic = preset.dynamic && look.dynamic ? look.dynamic : null;
  const slam = Boolean(preset.slam);
  const step = useWordStep(dynamic || slam ? line.words.length : 0);
  const family = look.fontFamily || preset.fontFamily;
  const highlight = look.highlight || preset.highlight;
  const row = look.position?.row ?? preset.row;

  // Shares of the frame turned into container-query units: 1cqmin is one per
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
  // The position's own margin when one was chosen, the preset's otherwise.
  const baseMargin = look.position?.marginRatio ?? preset.marginRatio;
  // Only the top row moves further: the renderer pushes top-aligned captions
  // below the headline band and leaves every other placement alone.
  const margin =
    row === 'top' && topMarginRatio !== undefined
      ? Math.max(baseMargin, topMarginRatio) * 100
      : baseMargin * 100;

  // A stroke ASS draws around every glyph, approximated by four shadows.
  // Four is the compromise: eight would be smoother and is twice the paint
  // on a video that is already playing.
  const stroke =
    outline > 0
      ? `${outline}cqmin 0 0 #000, -${outline}cqmin 0 0 #000, 0 ${outline}cqmin 0 #000, 0 -${outline}cqmin 0 #000`
      : `0 ${preset.shadowRatio * 100}cqmin ${preset.shadowRatio * 200}cqmin rgba(0,0,0,.75)`;

  const useEmphasis = preset.poster && line.emphasis !== null;
  // How far the loud line bites into a quiet neighbour: `overlap` of the two
  // lines' average height, which is how the renderer places their centres.
  const bite = ((size + size * poster.emphasisScale) * LINE_HEIGHT * poster.overlap) / 2;
  const emphasised = useEmphasis
    ? poster.uppercase
      ? line.words[line.emphasis!].toLocaleUpperCase('ru')
      : line.words[line.emphasis!]
    : null;

  if (preset.topic) {
    // The render's layout (topicLayout.ts), with the sample phrase standing in
    // for real ones: its emphasis word as the topic, its first half as the
    // lead-in, the rest as the key part. The model picks these for real.
    const words = line.words.map((w) => w.toLocaleUpperCase('ru'));
    const k = words.length <= 1 ? 0 : Math.floor(words.length / 2);
    const keyword = line.emphasis !== null ? words[line.emphasis] : words[0];
    const bottom = (preset.marginRatio ?? 0) * 100;
    return (
      <div className={styles.slamStage} aria-hidden="true">
        <span
          className={styles.topicWord}
          style={{ fontSize: `min(${em * 3.2}cqmin, ${80 / Math.max(1, keyword.length * 0.48)}cqw)`, color: highlight }}
        >
          {keyword}
        </span>
        <div className={`${styles.topicCaption} ${focused ? styles.focused : ''}`} style={{ bottom: `${bottom}cqh`, textShadow: stroke }}>
          {k > 0 && (
            <span className={styles.topicLead} style={{ fontSize: `${em * 0.35}cqmin`, color: preset.primary }}>
              {words.slice(0, k).join(' ')}
            </span>
          )}
          <span className={styles.topicKey} style={{ fontSize: `${em}cqmin`, color: preset.primary }}>
            {words.slice(k).join(' ')}
          </span>
        </div>
      </div>
    );
  }

  if (slam) {
    // One word at a time, as the render cuts them: the word being said, or
    // nothing in the pause after the phrase. Placed where the render places
    // it, and left to run past the frame's edges, which crop it — as they do
    // in the video.
    const word = step < line.words.length ? line.words[step] : null;
    return (
      <div className={styles.slamStage} aria-hidden="true">
        {word && (
          <span
            className={`${styles.slamWord} ${focused ? styles.focused : ''}`}
            style={{ top: `${anchorRatio * 100}%`, fontFamily: `'${family}', sans-serif`, fontSize: `${em}cqmin`, color: preset.primary }}
          >
            {word.toLocaleUpperCase('ru')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`${styles.stage} ${styles[row]}`} style={{ padding: `${margin}cqh 4cqw` }} aria-hidden="true">
      <div className={`${styles.block} ${focused ? styles.focused : ''}`} style={{ fontFamily: `'${family}', sans-serif`, textShadow: stroke }}>
        {dynamic ? (
          <DynamicBlock line={line} layout={dynamic} step={step} size={size} em={em} primary={preset.primary} highlight={highlight} />
        ) : useEmphasis ? (
          <>
            {line.words.slice(0, line.emphasis!).length > 0 && (
              <span className={styles.quiet} style={{ fontSize: `${em}cqmin`, lineHeight: `${size * LINE_HEIGHT}cqmin`, color: preset.primary }}>
                {line.words.slice(0, line.emphasis!).join(' ')}
              </span>
            )}
            <span
              className={styles.loud}
              style={{
                fontSize: `${em * poster.emphasisScale}cqmin`,
                lineHeight: `${size * poster.emphasisScale * LINE_HEIGHT}cqmin`,
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
                marginTop: line.emphasis! > 0 ? `${-bite}cqmin` : undefined,
                marginBottom: line.emphasis! < line.words.length - 1 ? `${-bite}cqmin` : undefined,
              }}
            >
              {emphasised}
            </span>
            {line.words.slice(line.emphasis! + 1).length > 0 && (
              <span className={styles.quiet} style={{ fontSize: `${em}cqmin`, lineHeight: `${size * LINE_HEIGHT}cqmin`, color: preset.primary }}>
                {line.words.slice(line.emphasis! + 1).join(' ')}
              </span>
            )}
          </>
        ) : (
          <span className={styles.single} style={{ fontSize: `${em}cqmin`, color: preset.primary }}>
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

// How long each word of the sample takes to "say", and how long the finished
// phrase holds before it clears and starts over.
const WORD_MS = 450;
const HOLD_STEPS = 3;

/**
 * Which word of the sample is being said. Counts through the words, holds on
 * the finished phrase, and starts again — the preview of a look that lives in
 * time. With reduced motion it stays on the finished phrase.
 */
function useWordStep(count: number): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep(count - 1);
      return;
    }
    const timer = window.setInterval(() => setStep((s) => (s + 1) % (count + HOLD_STEPS)), WORD_MS);
    return () => window.clearInterval(timer);
  }, [count]);
  return count === 0 ? 0 : Math.min(step, count - 1 + HOLD_STEPS);
}

/**
 * "Динамика", drawn the way buildDynamicEvents lays it out: lower case,
 * short lines of up to maxWordsPerLine, the key word alone on its line and
 * larger. Words not yet said keep their place but are invisible, so nothing
 * shifts as they arrive; the word being said pops in; the ones before it dim
 * — all but the key word.
 */
function DynamicBlock({
  line,
  layout,
  step,
  size,
  em,
  primary,
  highlight,
}: {
  line: CaptionLine;
  layout: DynamicLayout;
  step: number;
  size: number;
  em: number;
  primary: string;
  highlight: string;
}) {
  const words = line.words.map((w) => w.toLocaleLowerCase('ru'));
  const rows: number[][] = [];
  let current: number[] = [];
  words.forEach((_, i) => {
    if (i === line.emphasis) {
      if (current.length) rows.push(current);
      rows.push([i]);
      current = [];
    } else if (current.length >= layout.maxWordsPerLine) {
      rows.push(current);
      current = [i];
    } else {
      current.push(i);
    }
  });
  if (current.length) rows.push(current);
  const finished = step >= words.length;

  return (
    <>
      {rows.map((row, r) => {
        const loud = row.length === 1 && row[0] === line.emphasis;
        const scale = loud ? layout.emphasisScale : 1;
        return (
          <span
            key={r}
            className={styles.dynamicRow}
            style={{ fontSize: `${em * scale}cqmin`, lineHeight: `${size * scale * layout.leading}cqmin` }}
          >
            {row.map((i, k) => {
              const said = i < step || finished;
              const saying = i === step && !finished;
              const opacity = !said && !saying ? 0 : said && i !== line.emphasis ? layout.dimOpacity : 1;
              // The space outside the word: inside an inline-block (which the
              // pop needs to scale) a trailing space is dropped.
              return (
                <Fragment key={i}>
                  <span
                    key={saying ? `${i}-now` : i}
                    className={saying ? styles.dynamicPop : styles.dynamicWord}
                    style={{ opacity, color: i === line.emphasis ? highlight : primary }}
                  >
                    {words[i]}
                  </span>
                  {k < row.length - 1 ? ' ' : ''}
                </Fragment>
              );
            })}
          </span>
        );
      })}
    </>
  );
}
