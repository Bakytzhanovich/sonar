import { describe, expect, it } from 'vitest';
import { PROBE_TIMEOUT_MS, RENDER_TIMEOUT_MS, probe } from '../src/ffmpeg';

describe('process deadlines', () => {
  it('gives the encode room and keeps probing tight', () => {
    // A probe reads headers; if it has not answered in two minutes the file
    // is not one we can work with. The encode legitimately runs for minutes.
    expect(PROBE_TIMEOUT_MS).toBeLessThan(RENDER_TIMEOUT_MS);
    expect(RENDER_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it('fails a missing file instead of waiting on it', async () => {
    // The deadline must not turn an ordinary error into a two-minute stall.
    const started = Date.now();
    await expect(probe('/nonexistent/file.mp4')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
