import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Separating a voice from the room it was recorded in.
//
// RNNoise, which this replaces, silences the pauses and leaves the noise that
// happens *while* someone is speaking — it passes through whatever it judges
// to be voice, and room tone under a voice is inside that judgement. Measured
// on real street footage the pauses came out at -70dB and the owner still
// heard the street, because his complaint was never about the pauses.
//
// DeepFilterNet separates speech from noise with a network trained to do
// exactly that, rather than by subtracting an estimated spectrum. On the same
// clip the gaps go from a dark haze to black and the band above the voice
// loses most of its wash, with the consonants intact.
//
// It is a separate binary rather than an ffmpeg filter, so the audio is
// cleaned before the render and handed to the graph as a second input. That
// is also why this degrades rather than fails: where the binary is missing,
// the pipeline keeps the old in-graph chain.

const DEEP_FILTER = process.env.DEEP_FILTER_PATH ?? 'deep-filter';
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

// The model runs at 48kHz and resamples anything else internally; feeding it
// 48k mono directly avoids a conversion at each end.
const SAMPLE_RATE = 48_000;

// Generous: this is a whole track, and a long interview on a busy machine can
// take minutes. Short enough that a wedged process does not hold a worker
// slot for the rest of the day.
const TIMEOUT_MS = 15 * 60 * 1000;

/** Whether the cleaner is installed and runnable. */
export async function deepFilterAvailable(): Promise<boolean> {
  try {
    await run(DEEP_FILTER, ['--help'], 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cleans the source's audio and writes it as a wav beside the render.
 *
 * Returns the path to the cleaned track, or null when the cleaner is not
 * available or fails. Null means "carry on without me": a render with the
 * older denoiser is worth far more than no render.
 *
 * The output keeps the source's timeline exactly — same length, no offset —
 * because the render graph cuts it with timestamps taken from the original.
 */
export async function cleanAudioTrack(sourcePath: string, workDir: string): Promise<string | null> {
  const rawPath = path.join(workDir, 'df-input.wav');
  const outDir = path.join(workDir, 'df-out');

  try {
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', sourcePath,
      '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
      rawPath,
    ], TIMEOUT_MS);

    await fs.mkdir(outDir, { recursive: true });
    // --pf is the post-filter: it trades a little more processing for
    // noticeably less residual noise between words, which is the part of the
    // recording people actually notice.
    await run(DEEP_FILTER, ['--pf', '-o', outDir, rawPath], TIMEOUT_MS);

    // The tool names its output after the input file rather than taking an
    // output path, so the name is derived rather than chosen.
    const cleaned = path.join(outDir, path.basename(rawPath));
    await fs.access(cleaned);
    return cleaned;
  } catch (err) {
    console.warn(`[deep-filter] falling back to the in-graph denoiser: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}
