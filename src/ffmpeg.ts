import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KeepSegment } from './smartCut';

// Thin wrapper around the ffmpeg/ffprobe binaries. Deliberately not a library
// wrapper (fluent-ffmpeg and friends): everything below is argument
// construction plus stdout parsing, and the filter graph is the part that
// actually matters — hiding it behind a fluent API would make it harder to
// read, not easier.
//
// The binaries are NOT bundled with the Node runtime. See Dockerfile: the
// worker image installs them with apt. ffmpegAvailable() is what turns
// "binary missing" into an honest job failure instead of an ENOENT stack
// trace.

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const OUTPUT_FPS = 30;

// Length of the fade applied to each side of every audio segment. Without it
// each join lands on an arbitrary point in the waveform and the discontinuity
// is audible as a click on every single cut — with a few dozen cuts per reel
// that is the difference between "edited" and "broken". 15ms is short enough
// to be inaudible as a fade and long enough to kill the step.
const JOIN_FADE_SEC = 0.015;

// RNNoise model for the arnndn filter — a recurrent network that separates
// speech from background noise (street, wind, room tone). Committed to the
// repo under assets/ (see the README there) rather than fetched at build
// time. Overridable so a deployment can point at a different model without a
// rebuild.
export const RNNOISE_MODEL_PATH =
  process.env.RNNOISE_MODEL_PATH ?? path.resolve(__dirname, '..', 'assets', 'rnnoise', 'bd.rnnn');

// RNNoise is trained at 48 kHz and degrades measurably at other rates, so the
// chain resamples into it and leaves the output at 48 kHz — which is what the
// AAC encoder wants anyway.
//
// The gain after the filter is not cosmetic: the model that removes the most
// noise also attenuates speech (-9.5 dB peak vs -2.8 dB untouched), so
// without it "denoised" just means "quiet", and a quiet upload gets buried by
// the platforms' own loudness normalisation.
//
// A FIXED gain, deliberately — not speechnorm or loudnorm. Those raise quiet
// passages, which here means the pauses, which is exactly where the leftover
// noise lives: measured on a real clip, speechnorm pulled the noise floor
// from -37 dB back up to -20 dB and ended up WORSE than the weaker model.
// A flat gain moves signal and noise together and preserves the gain in SNR.
// alimiter catches the peaks the boost would otherwise clip.
export function buildDenoiseChain(modelPath: string = RNNOISE_MODEL_PATH): string {
  return (
    // Wind and handling rumble live below the voice and are what RNNoise
    // handles worst — a high-pass takes them out before the network sees
    // them, so it can spend its capacity on the noise it is actually good at.
    'highpass=f=80,' +
    `aresample=48000,arnndn=m=${escapeFilterPath(modelPath)},` +
    // A gentle spectral pass after the network cleans up what it leaves
    // behind. -30dB noise floor is deliberately conservative: pushed harder
    // this filter starts eating consonants.
    'afftdn=nf=-30,' +
    // +6dB, not the +10 that would restore the original peak level. Gain
    // lifts signal and noise together, so matching the source's loudness
    // would hand back the noise this chain just removed — measured on real
    // footage, +10dB put the floor back at -30dB, exactly where it started.
    // At +6 the floor sits at -34dB and speech at -5.4dB, which the
    // platforms' own loudness normalisation brings up the rest of the way.
    'volume=6dB,alimiter=limit=0.95,aresample=48000'
  );
}

export async function denoiseModelAvailable(modelPath: string = RNNOISE_MODEL_PATH): Promise<boolean> {
  try {
    await fs.access(modelPath);
    return true;
  } catch {
    return false;
  }
}

export interface ProbeResult {
  durationSec: number;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
}

export class FfmpegError extends Error {
  constructor(message: string, readonly stderrTail: string) {
    super(message);
    this.name = 'FfmpegError';
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

// Keeps only the tail of stderr. ffmpeg is extremely chatty (a per-frame
// progress line by default), and a failed render's whole stderr can run to
// megabytes — storing that in a failure_reason or a log line is useless and
// expensive. The last few KB always contain the actual error.
const STDERR_TAIL_BYTES = 4000;

// Deadlines, per operation. These processes parse files uploaded by users,
// and ffmpeg has a long history of inputs that make it spin: a malformed
// container it never stops probing, a stream that decodes to far more than
// its size suggests. Without a deadline such a file does not fail a job — it
// stops the worker, which takes one job at a time. The lease then expires,
// the next worker claims the same job, and hangs on the same file.
//
// Generous, because the honest cases are slow too: a 20-minute source
// re-encodes in a few minutes on a small machine. The point is a ceiling
// that exists, not a tight one.
export const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
export const RENDER_TIMEOUT_MS = 45 * 60 * 1000;

function run(
  bin: string,
  args: string[],
  onStdout?: (chunk: string) => void,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: a process wedged in a decode loop may
      // never reach a point where it handles a signal it could ignore.
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString();
      if (onStdout) onStdout(text);
      else stdout += text;
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr = (stderr + buf.toString()).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} could not be started: ${err.message}`, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new FfmpegError(`${bin} killed after ${Math.round(timeoutMs / 1000)}s`, stderr));
      }
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${bin} exited with code ${code}`, stderr));
    });
  });
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(FFMPEG, ['-version']);
    await run(FFPROBE, ['-version']);
    return true;
  } catch {
    return false;
  }
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');

  // format.duration is absent for some containers (notably a raw stream or a
  // truncated upload); the video stream's own duration is the fallback. If
  // neither is present the file is not something we can plan an edit against.
  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? NaN);

  return {
    durationSec,
    hasAudio,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

// Extracts mono 16kHz audio — the format Whisper wants. Sending the original
// video to the transcription API instead would upload tens of megabytes per
// job (and hit the API's 25MB limit on longer clips) to transmit information
// the model discards anyway.
export async function extractAudio(inputPath: string, outputPath: string): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame', '-q:a', '4',
    outputPath,
  ]);
}

export interface NoiseMeasurement {
  rmsDb: number;
  noiseFloorDb: number;
  // How far the speech sits above the background. This, not the absolute
  // floor, is what decides whether a listener hears noise: a quietly recorded
  // clip has a low floor AND low speech, and cleaning it would gain nothing.
  headroomDb: number;
}

// Measured on real footage: an outdoor selfie with wind leaves ~14dB of
// headroom, a clean recording ~60dB. 25 sits well clear of both, so the
// decision does not hinge on a borderline case.
export const NOISY_HEADROOM_DB = 25;

// Reads levels with astats. Cheap — it decodes the already-extracted audio
// track, not the video — so it can run on every job to decide whether
// denoising is warranted instead of asking the user to guess.
export async function measureNoise(audioPath: string): Promise<NoiseMeasurement | null> {
  try {
    const { stderr } = await run(FFMPEG, [
      '-hide_banner', '-nostdin',
      '-i', audioPath,
      '-af', 'astats=metadata=1:reset=0',
      '-f', 'null', '-',
    ]).catch((err) => ({ stderr: err instanceof FfmpegError ? err.stderrTail : '' }));

    const rmsDb = Number(/RMS level dB:\s*(-?[\d.]+)/.exec(stderr)?.[1]);
    const noiseFloorDb = Number(/Noise floor dB:\s*(-?[\d.]+)/.exec(stderr)?.[1]);
    if (!Number.isFinite(rmsDb) || !Number.isFinite(noiseFloorDb)) return null;

    return { rmsDb, noiseFloorDb, headroomDb: rmsDb - noiseFloorDb };
  } catch {
    // A measurement failure must not fail the job — it only means the
    // automatic decision falls back to leaving the audio alone.
    return null;
  }
}

// Cuts a slice of audio to FLAC for Google Speech, which caps synchronous
// recognition at ~60s. FLAC because it is lossless: an MP3 re-encode of an
// already-compressed source smears exactly the consonant detail a recogniser
// depends on, and the file only travels to the API, never to a user.
export async function extractAudioChunk(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
  sampleRateHz: number
): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', startSec.toFixed(3),
    '-t', durationSec.toFixed(3),
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', String(sampleRateHz),
    '-c:a', 'flac',
    outputPath,
  ]);
}

// Grabs one frame as the card's cover image. Taken from the finished render,
// not the source, so the poster shows the actual result — subtitles burned in
// and all — which is what makes a completed job recognisable at a glance.
//
// The frame comes from a fraction into the clip rather than 0s: the first
// frame of a talking-head video is often mid-blink or a fade, and on a hard
// cut it can be a black frame, which is exactly the "did this work?" state
// the poster exists to avoid.
export async function extractPosterFrame(inputPath: string, outputPath: string, atSec: number): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    // Before -i, so ffmpeg seeks instead of decoding up to that point.
    '-ss', atSec.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    // Width 720 keeps the card crisp on a retina screen while staying a
    // ~60KB JPEG, so the queue does not pull megabytes of posters.
    '-vf', 'scale=720:-2',
    '-q:v', '4',
    outputPath,
  ]);
}

// Builds the trim/concat graph. One [v]/[a] pair per kept segment, all fed
// into a single concat — this is a single-pass re-encode, not N renders
// stitched together, so the cost is roughly one encode of the *output*
// duration regardless of how many cuts there are.
// A filter argument is parsed with ':' as the option separator and '\\' as an
// escape, so a path containing either breaks the graph in a way that reads as
// "no such filter". Escaped rather than quoted because quoting has its own
// nesting rules inside filter_complex.
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function buildConcatFilter(segments: KeepSegment[], subtitlePath?: string, denoiseModelPath?: string): string {
  const parts: string[] = [];
  const labels: string[] = [];

  segments.forEach((segment, i) => {
    const duration = segment.end - segment.start;
    const fadeOutStart = Math.max(0, duration - JOIN_FADE_SEC).toFixed(4);
    // setpts/asetpts rebase each fragment's timestamps to zero; without them
    // concat receives fragments that still carry their original timestamps
    // and the output keeps the gaps we just removed.
    parts.push(`[0:v]trim=start=${segment.start.toFixed(4)}:end=${segment.end.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(
      `[0:a]atrim=start=${segment.start.toFixed(4)}:end=${segment.end.toFixed(4)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${JOIN_FADE_SEC},afade=t=out:st=${fadeOutStart}:d=${JOIN_FADE_SEC}[a${i}]`
    );
    labels.push(`[v${i}][a${i}]`);
  });

  // Denoising AFTER the concat, not per segment: arnndn is a recurrent
  // network with internal state, and restarting it on every fragment would
  // make it re-learn the noise profile dozens of times per render — audible
  // as the hiss swelling back at each cut.
  const audioOut = denoiseModelPath ? '[acat]' : '[aout]';
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=1[vcat]${audioOut}`);
  if (denoiseModelPath) {
    parts.push(`[acat]${buildDenoiseChain(denoiseModelPath)}[aout]`);
  }
  // force_original_aspect_ratio=decrease + pad keeps a source that is not
  // exactly 9:16 (a 4:3 phone clip, a 1:1 export) intact with bars rather
  // than cropping the speaker's head off.
  //
  // The ass filter goes LAST, after scale/pad: libass renders at the frame
  // size it is given, so burning captions before the scale would resample the
  // text along with the picture and soften every edge. It also sits inside
  // this graph rather than in a separate -vf pass — ffmpeg rejects -vf and
  // -filter_complex on the same output, and a second pass would mean decoding
  // and re-encoding the whole video twice.
  const subtitleFilter = subtitlePath ? `,ass=filename=${escapeFilterPath(subtitlePath)}` : '';
  parts.push(
    `[vcat]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${OUTPUT_FPS}${subtitleFilter},format=yuv420p[vout]`
  );

  return parts.join(';\n');
}

export interface RenderOptions {
  inputPath: string;
  outputPath: string;
  workDir: string;
  segments: KeepSegment[];
  expectedDurationSec: number;
  // Absolute path to an .ass file to burn in. Optional: a job with subtitles
  // switched off renders the same graph without the filter.
  subtitlePath?: string;
  // Path to an RNNoise model. Absent: the audio is passed through untouched.
  denoiseModelPath?: string;
  onProgress?: (fraction: number) => void;
}

export async function renderSegments(options: RenderOptions): Promise<void> {
  const { inputPath, outputPath, workDir, segments, expectedDurationSec, subtitlePath, denoiseModelPath, onProgress } = options;
  if (segments.length === 0) throw new FfmpegError('no segments to render', '');

  // The graph is written to a file rather than passed as an argument: at a
  // few hundred segments the filter string runs past 100KB, and the OS
  // argument-length limit (ARG_MAX) turns that into an opaque E2BIG failure.
  const filterPath = path.join(workDir, 'filter.txt');
  await fs.writeFile(filterPath, buildConcatFilter(segments, subtitlePath, denoiseModelPath), 'utf-8');

  await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-filter_complex_script', filterPath,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-profile:v', 'high', '-level', '4.0',
      '-r', String(OUTPUT_FPS),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      // Puts the moov atom first so the result starts playing before it has
      // fully downloaded — the difference between a preview that plays and
      // one that spins.
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      outputPath,
    ],
    (chunk) => {
      if (!onProgress || expectedDurationSec <= 0) return;
      // -progress emits key=value lines; out_time_us is the position in the
      // OUTPUT timeline, so dividing by the planned output duration gives
      // real progress rather than the fabricated 25%-per-tick the mock
      // pipeline uses.
      for (const line of chunk.split('\n')) {
        const [key, value] = line.split('=');
        if (key !== 'out_time_us') continue;
        const seconds = Number(value) / 1_000_000;
        if (Number.isFinite(seconds)) onProgress(Math.min(1, Math.max(0, seconds / expectedDurationSec)));
      }
    },
    // The encode is the one operation that legitimately runs for minutes.
    RENDER_TIMEOUT_MS
  );
}
