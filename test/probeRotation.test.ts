import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probe } from '../src/ffmpeg';

// A real file rather than a mocked ffprobe answer: the bug was in which fields
// of ffprobe's output carry the turn, and a mock would only repeat our guess.
function ffmpegPresent(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'sonar-probe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ffmpegPresent())('probe on a phone clip stored on its side', () => {
  it('reports the size the video is shown at, not the size it is stored at', async () => {
    // How an iPhone stores an upright clip: 1920x1080 plus "turn 90°".
    // ffmpeg applies the turn when decoding, so the render sees a vertical
    // picture — and the layout has to be told the same, or it lays a vertical
    // video out as a landscape one.
    const stored = path.join(dir, 'stored.mp4');
    const turned = path.join(dir, 'turned.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=0.2', '-c:v', 'libx264', stored]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', stored, '-c', 'copy', turned]);

    const result = await probe(turned);
    expect({ width: result.width, height: result.height }).toEqual({ width: 180, height: 320 });
  });

  it('leaves an unturned clip as it is', async () => {
    const plain = path.join(dir, 'plain.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:duration=0.2', '-c:v', 'libx264', plain]);
    const result = await probe(plain);
    expect({ width: result.width, height: result.height }).toEqual({ width: 320, height: 180 });
  });
});
