import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnergyProfile } from './audioEnergy';
import { estimateLevels, findBreaths, type Interval } from './breathDetector';
import type { TranscriptWord } from './smartCut';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

// Below this the recording has no room for a breath to be distinguishable:
// measured on real street footage the band between room tone and voice is
// about 4dB, where wind and an inhale are the same reading. Cleaned, the
// same audio opens to 35dB. Rather than guess in the narrow case, the pass
// declines — a missed breath is untidy, a wrongly cut one is a missing
// syllable.
const MIN_USABLE_BAND_DB = 12;

/**
 * Prepares audio and looks for breaths in it.
 *
 * Extracts its own copy rather than reusing the transcription audio: that
 * file only exists on the run that transcribed, and a job resumed from a
 * checkpoint would find it gone. It is also denoised here when the render
 * will be denoised, because that is what opens the gap between room and
 * voice enough to see a breath at all.
 */
export async function runBreathPass(
  sourcePath: string,
  words: TranscriptWord[],
  durationSec: number,
  denoiseModelPath?: string
): Promise<Interval[]> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-breath-'));
  const audioPath = path.join(workDir, 'analysis.wav');

  try {
    // Deliberately gentler than the render's own chain (nf=-30, not -45).
    // This audio is never heard — it is measured, and the thresholds in
    // breathDetector.ts were calibrated against a signal cleaned exactly this
    // much. Cleaning harder here would push a breath below the floor the
    // detector looks above, and the pass would quietly stop finding anything.
    const filters = denoiseModelPath
      ? `highpass=f=80,aresample=48000,arnndn=m=${denoiseModelPath},afftdn=nf=-30,aresample=16000`
      : 'aresample=16000';

    await run([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', sourcePath,
      '-vn', '-ac', '1',
      '-af', filters,
      audioPath,
    ]);

    const profile = await readEnergyProfile(audioPath);
    const levels = estimateLevels(profile);
    if (!levels) return [];

    const band = levels.speechDb - levels.floorDb;
    if (band < MIN_USABLE_BAND_DB) return [];

    return findBreaths(profile, words, durationSec);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    // Analysis audio is cheap to produce; a minute is already generous.
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg breath-pass failed: ${stderr}`));
    });
  });
}
