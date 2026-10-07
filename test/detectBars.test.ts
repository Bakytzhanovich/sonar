import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectBars, mergeBarSamples, parseCropdetect } from '../src/ffmpeg';

const VERTICAL = { width: 1080, height: 1920 };

describe('parseCropdetect', () => {
  it('takes the last box reported, the widest with reset=0', () => {
    const stderr = [
      '[Parsed_cropdetect_0 @ 0x1] x1:0 x2:1079 y1:430 y2:1489 w:1080 h:1056 x:0 y:432 pts:0 t:0 crop=1080:1056:0:432',
      '[Parsed_cropdetect_0 @ 0x1] x1:0 x2:1079 y1:420 y2:1499 w:1080 h:1080 x:0 y:420 pts:1 t:0.03 crop=1080:1080:0:420',
    ].join('\n');
    expect(parseCropdetect(stderr)).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
  });

  it('reads an all-black frame as nothing found', () => {
    // cropdetect reports a frame with no picture in it as an inverted box.
    expect(parseCropdetect('crop=-1072:-1904:1078:1914')).toBeNull();
    expect(parseCropdetect('no crop lines here')).toBeNull();
  });
});

describe('mergeBarSamples', () => {
  it('keeps everything any sample saw, so a dark moment cannot crop the picture', () => {
    // The opening shot is dark at the top and reads as a taller bar there;
    // later frames show the picture reaching up to y=420.
    const merged = mergeBarSamples(
      [
        { x: 0, y: 700, width: 1080, height: 800 },
        { x: 0, y: 420, width: 1080, height: 1080 },
        { x: 0, y: 420, width: 1080, height: 1080 },
      ],
      VERTICAL
    );
    expect(merged).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
  });

  it('ignores slivers too thin to be bars', () => {
    expect(mergeBarSamples([{ x: 0, y: 8, width: 1080, height: 1904 }], VERTICAL)).toBeNull();
  });

  it('crops each axis only where it has a real bar', () => {
    // A real bar top and bottom, a 4px sliver at the sides: the sides stay.
    expect(mergeBarSamples([{ x: 2, y: 420, width: 1076, height: 1080 }], VERTICAL)).toEqual({
      x: 0,
      y: 420,
      width: 1080,
      height: 1080,
    });
  });

  it('refuses to crop away most of the frame — that is a dark video, not bars', () => {
    expect(mergeBarSamples([{ x: 0, y: 860, width: 1080, height: 200 }], VERTICAL)).toBeNull();
  });

  it('finds nothing without samples', () => {
    expect(mergeBarSamples([], VERTICAL)).toBeNull();
  });
});

function ffmpegPresent(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'sonar-bars-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ffmpegPresent())('detectBars on a real file', () => {
  // Small frames so the encode takes milliseconds; the shapes are what matter.
  it('finds bars baked into a vertical export of a square clip', async () => {
    const file = path.join(dir, 'letterboxed.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=270x270:duration=2', '-vf', 'pad=270:480:0:104:black', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    const crop = await detectBars(file, 2, { width: 270, height: 480 });
    expect(crop).not.toBeNull();
    // Even-pixel rounding may give or take a row at each edge.
    expect(Math.abs(crop!.y - 104)).toBeLessThanOrEqual(2);
    expect(Math.abs(crop!.height - 270)).toBeLessThanOrEqual(4);
    expect(crop!.width).toBe(270);
  });

  it('finds nothing in a clip that fills its frame', async () => {
    const file = path.join(dir, 'full.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=270x480:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    expect(await detectBars(file, 2, { width: 270, height: 480 })).toBeNull();
  });
});
