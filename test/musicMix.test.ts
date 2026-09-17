import { describe, expect, it } from 'vitest';
import { buildMusicFilter, DEFAULT_MUSIC_OPTIONS } from '../src/musicMix';

describe('music ducking', () => {
  const filter = buildMusicFilter('aout', '1:a', 'mixed', 30);

  it('drives the compressor from the voice, not the music', () => {
    // A compressor keyed by its own input is just a compressor; the whole
    // point is that the voice controls the music's level.
    expect(filter).toMatch(/\[music\]\[trigger\]sidechaincompress/);
  });

  it('splits the speech, since one stream cannot be both trigger and output', () => {
    expect(filter).toContain('asplit=2[speech][trigger]');
    // The untouched copy is what the viewer hears.
    expect(filter).toMatch(/\[speech\]\[ducked\]amix/);
  });

  it('fits the music to the video in both directions', () => {
    // Short track: loop. Long track: trim. Either way no silence partway
    // through and no music tail after the speaker stops.
    expect(filter).toContain('aloop=loop=-1');
    expect(filter).toContain('atrim=duration=30.000');
  });

  it('ducks deeply enough to hear, without swallowing the bed', () => {
    // Measured: these settings give ~10dB. At ratio 6 the ducking is barely
    // audible; at 16 the music disappears under the voice entirely.
    expect(DEFAULT_MUSIC_OPTIONS.duckRatio).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_MUSIC_OPTIONS.duckRatio).toBeLessThanOrEqual(14);
  });

  it('releases slowly enough not to pump between phrases', () => {
    // At a couple of hundred milliseconds the bed audibly lifts between
    // every phrase, which draws attention to the effect.
    expect(DEFAULT_MUSIC_OPTIONS.releaseMs).toBeGreaterThanOrEqual(600);
    // And ducks fast enough that the first syllable is not buried.
    expect(DEFAULT_MUSIC_OPTIONS.attackMs).toBeLessThanOrEqual(20);
  });

  it('keeps the bed under the voice even before ducking', () => {
    expect(DEFAULT_MUSIC_OPTIONS.gainDb).toBeLessThan(0);
  });

  it('does not let amix quietly halve the levels', () => {
    // normalize=1 (the default) divides every input by their count, undoing
    // the levels chosen above.
    expect(filter).toContain('normalize=0');
  });

  it('limits the mix rather than letting it clip', () => {
    expect(filter).toContain('alimiter');
  });

  it('fades in and out instead of starting mid-bar', () => {
    expect(filter).toContain('afade=t=in');
    expect(filter).toContain('afade=t=out');
  });
});
