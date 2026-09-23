import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnergyProfile } from './audioEnergy';
import { estimateLevels } from './breathDetector';
import { tightenWordsToSpeech, type TightenResult } from './speechTiming';
import type { TranscriptWord } from './smartCut';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

/**
 * Measures the recording and hands back word timings that match it.
 *
 * See speechTiming.ts for why the timings that arrive need correcting at all.
 * This is only the part that needs a file and a subprocess; the decision about
 * where a word ends is pure and lives there.
 *
 * Extracts its own copy of the audio rather than reusing the transcription's,
 * for the same reason the breath pass does: that file belongs to the run that
 * transcribed, and a job resumed from a checkpoint would find it gone.
 *
 * Deliberately NOT denoised, unlike the breath pass. A breath has to be picked
 * out from room tone, which needs the room removed first; a pause does not —
 * speech sits tens of decibels above silence in the raw signal, and cleaning
 * first would only risk pushing a quietly-spoken word below the threshold and
 * cutting it out of someone's video.
 */
export async function runSpeechTimingPass(
  sourcePath: string,
  words: TranscriptWord[]
): Promise<TightenResult> {
  const unchanged: TightenResult = { words, reclaimedSec: 0, tightenedCount: 0 };
  if (words.length === 0) return unchanged;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-timing-'));
  const audioPath = path.join(workDir, 'analysis.wav');
  try {
    await run([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', sourcePath,
      '-vn', '-ac', '1', '-ar', '16000',
      audioPath,
    ]);

    const profile = await readEnergyProfile(audioPath);
    const levels = estimateLevels(profile);
    // No measurable difference between loud and quiet means there is nothing
    // to trim against — a constant-level recording, or one too short to
    // profile. Leaving the timings alone is the honest answer.
    if (!levels) return unchanged;

    return tightenWordsToSpeech(words, profile, levels);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`[speech-timing] could not remove ${workDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg speech-timing pass failed: ${stderr}`));
    });
  });
}
