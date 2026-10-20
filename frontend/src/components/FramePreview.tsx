'use client';

import { useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import CaptionOverlay, { type CaptionLine, type CaptionLook } from './CaptionOverlay';
import styles from './FramePreview.module.css';
// The renderer's own geometry, imported rather than restated. Where the band
// sits, how far the picture moves down for it, how the words wrap inside it
// and how far top captions are pushed clear of it are four decisions a client
// has already caught going wrong in finished renders — a title stranded at
// the frame edge, a gap above the picture instead of below it. A copy of them
// here would be the next place for the same bug to live.
import { aspectRatioFor } from '@shared/aspect';
import { assToRgb } from '@shared/assColour';
import { wordAnchorY } from '@shared/subtitles';
import {
  bandHeightFor,
  bandLayoutFor,
  clearOfHeadline,
  headlineStyleFor,
  sanitizeHeadline,
  scaleHeadlineToFrame,
  headlineLinesFor,
} from '@shared/headline';

// The whole output frame in miniature: the headline band, the picture where
// the renderer will put it, and the captions over both. Everything is laid out
// in shares of the frame, because the renderer thinks in pixels of a frame the
// browser does not have — 1080x1920, 1080x1080, 1920x1080 — and a share is the
// one unit both sides mean the same thing by.

/** The preview's area in CSS pixels: the 280×498 a vertical frame always had. */
const PREVIEW_AREA = 280 * 498;

export default function FramePreview({
  src,
  aspectRatio,
  frameFill = 'blur',
  headline,
  headlineChoice,
  captions,
  fontEmRatios,
  focus = null,
}: {
  src: string;
  aspectRatio: string;
  /** Blurred copy around the picture, as the render does by default, or black bars. */
  frameFill?: 'blur' | 'black' | 'crop';
  headline: string;
  headlineChoice: { font: string; size: string; colour: string };
  captions: { line: CaptionLine; look: CaptionLook } | null;
  /** Family to how big libass draws its em (see assEmRatio on the server). */
  fontEmRatios: Record<string, number>;
  /** Outlines what the settings are currently changing. */
  focus?: 'captions' | 'headline' | null;
}) {
  // The source's own shape, known once the browser has read the file's
  // header. Until then it is taken to fill the frame, which is what the
  // renderer assumes too when it cannot measure the source.
  const [source, setSource] = useState<{ width: number; height: number } | null>(null);
  // The blurred fill behind the picture is a second, muted copy of the same
  // video kept in step with the one that plays — the render fills the
  // frame with the moving picture, and a still would promise something else.
  const fill = useRef<HTMLVideoElement>(null);
  const main = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const video = main.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };
  const follow = (main: HTMLVideoElement) => {
    const copy = fill.current;
    if (!copy) return;
    if (Math.abs(copy.currentTime - main.currentTime) > 0.3) copy.currentTime = main.currentTime;
    if (main.paused) copy.pause();
    else void copy.play().catch(() => {});
  };

  const frame = aspectRatioFor(aspectRatio);
  const text = sanitizeHeadline(headline);
  const lines = text ? headlineLinesFor(text, frame) : [];
  const baseHeadline = headlineStyleFor({ font: headlineChoice.font, size: headlineChoice.size, colour: headlineChoice.colour });
  // The render's own figure for this text in this frame (bandHeightFor).
  const band = lines.length > 0 ? bandHeightFor(frame, baseHeadline, lines.length) : 0;
  // Cropped to fill: no bars, the picture is the whole frame — as the render lays it out.
  const layout = bandLayoutFor(frame, frameFill === 'crop' ? null : source, band);

  const headlineStyle = scaleHeadlineToFrame(baseHeadline, frame, lines.length);
  // The renderer drops to the smaller size on a third line so a long title
  // still fits the band; the preview has to make the same step or it will
  // show three lines the render cannot fit.
  const headlinePx = lines.length >= 3 ? headlineStyle.fontSizeSmall : headlineStyle.fontSize;

  // Top-aligned captions are pushed below the band by the renderer, by
  // exactly this rule. Asked of the same function rather than recomputed.
  const topClearance = captions
    ? clearOfHeadline(
        { alignment: 8, marginV: captions.look.preset.marginRatio * frame.height },
        text,
        layout.bandTop + band
      ).marginV / frame.height
    : undefined;

  const pct = (px: number) => `${(px / frame.height) * 100}%`;

  // The same AREA for every shape, not the same width: a single 280px cap
  // gave a vertical frame 280×498 and a landscape one 280×157 — the format
  // looked like it shrank the video. Equal area keeps all three the size of
  // the familiar vertical one (280×498 → 373×373 → 498×280), and no taller
  // than 60% of the screen.
  const ratio = frame.width / frame.height;
  const areaWidth = Math.round(Math.sqrt(PREVIEW_AREA * ratio));
  const width = `min(100%, ${areaWidth}px, calc(60vh * ${ratio.toFixed(4)}))`;

  return (
    // --frame-ratio lets a parent cap the frame by HEIGHT (width = height ×
    // ratio) without knowing the format — the phone editor does, so the
    // settings under the frame stay on the same screen as it.
    <div
      className={styles.frame}
      style={{ ['--preview-width' as string]: width, aspectRatio: `${frame.width} / ${frame.height}`, ['--frame-ratio' as string]: ratio }}
    >
      {/* The picture fitted into the whole frame and centred over a blurred
          copy of itself — the same fit buildFitChain does in the render. The
          headline never takes room from it. */}
      {/* Black bars are just the frame's own black background showing. */}
      {frameFill === 'blur' && (
        <video className={styles.fill} ref={fill} src={src} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
      )}
      <div className={styles.picture} style={{ top: 0, height: '100%' }}>
        {/* No native controls: their bar sits across the bottom of the frame —
            exactly where captions go — and hid them in every format wider
            than 9:16. One play/pause button instead (below). */}
        <video
          ref={main}
          className={`${styles.video} ${frameFill === 'crop' ? styles.cover : ''}`}
          src={src}
          playsInline
          loop
          preload="metadata"
          onLoadedMetadata={(e) => {
            const { videoWidth, videoHeight } = e.currentTarget;
            if (videoWidth && videoHeight) setSource({ width: videoWidth, height: videoHeight });
          }}
          onPlay={(e) => { setPlaying(true); follow(e.currentTarget); }}
          onPause={(e) => { setPlaying(false); follow(e.currentTarget); }}
          onSeeked={(e) => follow(e.currentTarget)}
        />
      </div>

      {lines.length > 0 && (
        <div
          className={`${styles.band} ${focus === 'headline' ? styles.focused : ''}`}
          style={{
            top: pct(layout.bandTop),
            height: pct(band),
            fontFamily: `'${headlineStyle.fontName}', sans-serif`,
            // Headline sizes follow the HEIGHT, unlike captions: the words
            // have to fit the band and the band is a share of the height.
            // Drawn at the em libass will actually draw, and spaced a full
            // ASS size apart, which is how libass stacks the lines of a \N.
            fontSize: `${(headlinePx / frame.height) * 100 * (fontEmRatios[headlineStyle.fontName] ?? 1)}cqh`,
            lineHeight: `${(headlinePx / frame.height) * 100}cqh`,
            color: assToRgb(headlineStyle.primaryColour),
          }}
        >
          {lines.map((line, i) => (
            <span key={i} className={styles.headlineLine}>
              {line}
            </span>
          ))}
        </div>
      )}

      {captions && (
        <CaptionOverlay
          line={captions.line}
          look={captions.look}
          topMarginRatio={topClearance}
          focused={focus === 'captions'}
          anchorRatio={wordAnchorY(frame.height, layout.pictureTop) / frame.height}
        />
      )}

      {/* Above the overlays, which draw nothing to click on: a tap anywhere on
          the frame plays or pauses; the round mark shows only while paused. */}
      <button
        type="button"
        className={`${styles.playToggle} ${playing ? styles.playing : ''}`}
        onClick={toggle}
        aria-label={playing ? 'Пауза' : 'Смотреть'}
      >
        <span className={styles.playMark} aria-hidden="true">
          {playing ? <Pause size={22} strokeWidth={2.25} /> : <Play size={22} strokeWidth={2.25} />}
        </span>
      </button>
    </div>
  );
}
