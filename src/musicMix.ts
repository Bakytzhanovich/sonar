import { escapeFilterPath } from './ffmpeg';

// Background music that gets out of the way of the voice.
//
// Mixing music under speech at a fixed level does not work: set it where the
// words stay clear and nobody hears the music, set it where the music works
// and the words are buried. Ducking solves that by making the level depend
// on the voice — the music drops while someone is speaking and comes back in
// the gaps.
//
// sidechaincompress is what does it: a compressor whose trigger is a
// different signal than the one it attenuates. The voice is the trigger, the
// music is what gets attenuated. It is the same tool radio has used for
// announcements over a bed for decades.

export interface MusicOptions {
  /**
   * Music level before ducking, in dB relative to its own file. Negative:
   * even undicked, a bed sits under the voice rather than beside it.
   */
  gainDb: number;
  /** How far the music drops while the voice is present. */
  duckRatio: number;
  /** Voice level at which ducking starts, 0-1 of full scale. */
  threshold: number;
  /** Milliseconds to duck. Fast, or the first syllable is buried. */
  attackMs: number;
  /**
   * Milliseconds to come back. Slow, or the music pumps audibly in the
   * gaps between words — the most common way ducking is done badly.
   */
  releaseMs: number;
}

// Measured on speech with real pauses, reading the ducked music on its own:
//
//   threshold 0.05 / ratio 6   →  4.2 dB   barely audible as ducking
//   threshold 0.03 / ratio 8   →  7.1 dB
//   threshold 0.02 / ratio 12  → 10.3 dB   ← here
//   threshold 0.01 / ratio 16  → 15.8 dB   music disappears under the voice
//
// 10dB is the point where the voice is clearly in front and the bed is still
// present underneath, rather than cutting in and out.
export const DEFAULT_MUSIC_OPTIONS: MusicOptions = {
  gainDb: -14,
  duckRatio: 12,
  threshold: 0.02,
  attackMs: 5,
  // Deliberately long: at 200ms the bed audibly lifts between every phrase,
  // which draws attention to the effect instead of the content.
  releaseMs: 900,
};

// IMPORTANT, and learned the hard way: the sidechain trigger must be CLEAN
// speech. Measured against the raw street recording — noise floor at -37dB —
// the compressor never released, because the noise itself sat above the
// threshold the whole time; the music came out uniformly crushed and
// slightly LOUDER during speech than in the gaps. On the denoised version of
// the same audio the ducking works as intended. In the pipeline the render's
// audio is already denoised when denoising is on, which is the signal to
// key from.

/**
 * Filter chain mixing a music track under an already-rendered speech track.
 *
 * Takes labelled inputs rather than stream indices so it can be spliced into
 * the render graph, where the speech is the output of the concat rather than
 * an input file.
 */
export function buildMusicFilter(
  speechLabel: string,
  musicLabel: string,
  outLabel: string,
  durationSec: number,
  options: MusicOptions = DEFAULT_MUSIC_OPTIONS
): string {
  const { gainDb, duckRatio, threshold, attackMs, releaseMs } = options;

  return [
    // The music is looped and then cut to length: a track shorter than the
    // video would otherwise end in silence partway through, and one longer
    // would pad the video with a tail of music after the speaker stops.
    `[${musicLabel}]aloop=loop=-1:size=2e9,atrim=duration=${durationSec.toFixed(3)},` +
      `volume=${gainDb}dB,afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, durationSec - 2).toFixed(3)}:d=2[music]`,
    // The speech is duplicated: one copy triggers the compressor, the other
    // is mixed in untouched. Without the split the same stream cannot be
    // both the sidechain input and the output.
    `[${speechLabel}]asplit=2[speech][trigger]`,
    `[music][trigger]sidechaincompress=threshold=${threshold}:ratio=${duckRatio}:attack=${attackMs}:release=${releaseMs}[ducked]`,
    // normalize=0 keeps amix from quietly halving both inputs to avoid
    // clipping — the levels are already deliberate, and the limiter after
    // this handles peaks.
    `[speech][ducked]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[${outLabel}]`,
  ].join(';');
}

/** The -i argument for the music file, escaped for a filter graph. */
export function musicInputPath(path: string): string {
  return escapeFilterPath(path);
}
