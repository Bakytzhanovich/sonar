import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { EnergyPoint } from './breathDetector';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

// Window length for the energy profile. 50ms is short enough to catch a
// breath (a few tenths of a second) and long enough that one is described by
// several points rather than one — a single sample either side of a
// threshold would make the detector jittery.
const WINDOW_SEC = 0.05;

/**
 * RMS level over time, read out of ffmpeg's own statistics filter.
 *
 * astats with reset=N recomputes per window and ametadata prints each value;
 * parsing that is far cheaper than decoding the waveform into Node and
 * computing it here, and it keeps the arithmetic in the same tool that does
 * the rest of the audio work.
 */
export async function readEnergyProfile(audioPath: string): Promise<EnergyPoint[]> {
  const outPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sonar-energy-')), 'rms.txt');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', audioPath,
      '-af', `astats=metadata=1:reset=1:length=${WINDOW_SEC},ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${outPath}`,
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg astats failed: ${stderr}`))));
  });

  try {
    const text = await fs.readFile(outPath, 'utf-8');
    return parseEnergyProfile(text);
  } finally {
    await fs.rm(path.dirname(outPath), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parses ametadata's output: a "pts_time:" line, then the value line.
 *
 * Exported for its own test — the format is ffmpeg's, not ours, and a
 * silently empty parse would disable breath removal without failing
 * anything.
 */
export function parseEnergyProfile(text: string): EnergyPoint[] {
  const points: EnergyPoint[] = [];
  let pending: number | null = null;

  for (const line of text.split('\n')) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) {
      pending = Number(time[1]);
      continue;
    }
    const value = /RMS_level=(-?[0-9.]+|-inf)/.exec(line);
    if (value && pending !== null) {
      // Digital silence prints as -inf, which is a real reading, not a
      // parse failure: clamp it to something arithmetic can use.
      const db = value[1] === '-inf' ? -120 : Number(value[1]);
      if (Number.isFinite(db)) points.push({ timeSec: pending, db });
      pending = null;
    }
  }
  return points;
}
