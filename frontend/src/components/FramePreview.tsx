'use client';

import { useState } from 'react';
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
import {
  bandHeightForFrame,
  bandLayoutFor,
  clearOfHeadline,
  headlineStyleFor,
  sanitizeHeadline,
  scaleHeadlineToFrame,
  wrapHeadline,
} from '@shared/headline';

// The whole output frame in miniature: the headline band, the picture where
// the renderer will put it, and the captions over both. Everything is laid out
// in shares of the frame, because the renderer thinks in pixels of a frame the
// browser does not have — 1080x1920, 1080x1080, 1920x1080 — and a share is the
// one unit both sides mean the same thing by.

export default function FramePreview({
  src,
  aspectRatio,
  headline,
  headlineChoice,
  captions,
  fontEmRatios,
}: {
  src: string;
  aspectRatio: string;
  headline: string;
  headlineChoice: { font: string; size: string; colour: string };
  captions: { line: CaptionLine; look: CaptionLook } | null;
  /** Family to how big libass draws its em (see assEmRatio on the server). */
  fontEmRatios: Record<string, number>;
}) {
  // The source's own shape, known once the browser has read the file's
  // header. Until then the band takes its full room at the top, which is what
  // the renderer does too when it cannot measure the source.
  const [source, setSource] = useState<{ width: number; height: number } | null>(null);

  const frame = aspectRatioFor(aspectRatio);
  const text = sanitizeHeadline(headline);
  const lines = text ? wrapHeadline(text) : [];
  const band = lines.length > 0 ? bandHeightForFrame(frame) : 0;
  const layout = bandLayoutFor(frame, source, band);

  const headlineStyle = scaleHeadlineToFrame(
    headlineStyleFor({ font: headlineChoice.font, size: headlineChoice.size, colour: headlineChoice.colour }),
    frame
  );
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

  return (
    <div className={styles.frame} style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
      {/* The picture's box is the frame minus what the band reserves, and the
          video is fitted inside it — the same "scale into the space left,
          centre it there" the ffmpeg filter graph does. */}
      <div className={styles.picture} style={{ top: pct(layout.reserve), height: pct(frame.height - layout.reserve) }}>
        <video
          className={styles.video}
          src={src}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const { videoWidth, videoHeight } = e.currentTarget;
            if (videoWidth && videoHeight) setSource({ width: videoWidth, height: videoHeight });
          }}
        />
      </div>

      {lines.length > 0 && (
        <div
          className={styles.band}
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

      {captions && <CaptionOverlay line={captions.line} look={captions.look} topMarginRatio={topClearance} />}
    </div>
  );
}
