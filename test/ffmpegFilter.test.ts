import { describe, it, expect } from 'vitest';
import { buildConcatFilter, buildDenoiseChain, escapeFilterPath, OUTPUT_HEIGHT, OUTPUT_WIDTH, OUTPUT_FPS } from '../src/ffmpeg';

// Pure string construction — no binary involved, which is the point: the
// filter graph is the part of the render that fails silently (a wrong label
// produces a video with no audio, or the removed pauses still present) and
// this is the only place it can be checked cheaply.
describe('buildConcatFilter', () => {
  const segments = [{ start: 0, end: 1.5 }, { start: 4, end: 6 }];

  it('emits one video and one audio branch per segment, then concatenates them', () => {
    const filter = buildConcatFilter(segments);

    expect(filter).toContain('[0:v]trim=start=0.0000:end=1.5000');
    expect(filter).toContain('[0:a]atrim=start=4.0000:end=6.0000');
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][aout]');
  });

  it('rebases timestamps on every fragment', () => {
    // Without setpts/asetpts each fragment keeps its original timeline and
    // concat reproduces exactly the gaps the edit just removed.
    const filter = buildConcatFilter(segments);
    // ',setpts' excludes ',asetpts', which contains it as a substring.
    expect(filter.match(/,setpts=PTS-STARTPTS/g)).toHaveLength(2);
    expect(filter.match(/,asetpts=PTS-STARTPTS/g)).toHaveLength(2);
  });

  it('fades each audio fragment in and out to kill join clicks', () => {
    const filter = buildConcatFilter(segments);
    expect(filter.match(/afade=t=in/g)).toHaveLength(2);
    // The fade-out is anchored to the fragment's own length, not the source's.
    expect(filter).toContain('afade=t=out:st=1.4850');
    expect(filter).toContain('afade=t=out:st=1.9850');
  });

  it('normalizes the output to 1080x1920 at 30fps with padding, not cropping', () => {
    const filter = buildConcatFilter(segments);
    expect(filter).toContain(`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`);
    expect(filter).toContain(`pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`);
    expect(filter).toContain(`fps=${OUTPUT_FPS}`);
  });

  it('handles a single-segment plan (nothing was cut)', () => {
    const filter = buildConcatFilter([{ start: 0, end: 10 }]);
    expect(filter).toContain('concat=n=1:v=1:a=1[vcat][aout]');
  });
});

describe('burned-in subtitles', () => {
  const segments = [{ start: 0, end: 1.5 }, { start: 4, end: 6 }];

  it('omits the ass filter entirely when no subtitle file is given', () => {
    expect(buildConcatFilter(segments)).not.toContain('ass=');
  });

  it('burns captions after scaling, not before', () => {
    const filter = buildConcatFilter(segments, '/tmp/job/captions.ass');

    // libass renders at the frame size it is handed; scaling afterwards would
    // resample the text and soften every edge. The filter's own options are
    // matched loosely — what this pins is the position in the chain.
    expect(filter).toMatch(/fps=30,ass=filename=\/tmp\/job\/captions\.ass[^,]*,format=yuv420p\[vout\]/);
  });

  it('points libass at the fonts that ship with the code', () => {
    // Without fontsdir libass asks the system, and answers a family it cannot
    // find by silently using another one. That is not hypothetical: captions
    // rendered in Verdana for days because the laptop running the worker had
    // no Montserrat and nothing reported the substitution.
    const filter = buildConcatFilter(segments, '/tmp/job/captions.ass');
    expect(filter).toContain('fontsdir=');
    expect(filter).toMatch(/fontsdir=[^,:]*assets/);
  });

  it('stays inside the single filter_complex pass', () => {
    // ffmpeg rejects -vf together with -filter_complex on the same output, and
    // a separate pass would decode and re-encode the whole video twice.
    const filter = buildConcatFilter(segments, '/tmp/job/captions.ass');
    expect(filter.match(/\[vout\]/g)).toHaveLength(1);
  });

  it('escapes the characters that would break the filter argument', () => {
    // ':' separates filter options and '\\' is the escape — an unescaped path
    // containing either fails as an unrelated-looking "no such filter".
    expect(escapeFilterPath('/tmp/a:b/c.ass')).toBe('/tmp/a\\:b/c.ass');
    expect(escapeFilterPath("/tmp/it's/c.ass")).toBe("/tmp/it\\'s/c.ass");
  });
});

describe('denoise (RNNoise / arnndn)', () => {
  const segments = [{ start: 0, end: 2 }, { start: 5, end: 7 }];

  it('leaves the audio untouched when no model is given', () => {
    const graph = buildConcatFilter(segments);
    expect(graph).not.toContain('arnndn');
    // concat must still land straight on the output label.
    expect(graph).toContain('concat=n=2:v=1:a=1[vcat][aout]');
  });

  it('runs the network once on the joined audio, not per segment', () => {
    const graph = buildConcatFilter(segments, undefined, '/models/cb.rnnn');

    // Exactly one arnndn: restarting a recurrent denoiser at every cut makes
    // it re-learn the noise profile and the hiss swells back on each join.
    expect(graph.match(/arnndn/g)).toHaveLength(1);
    expect(graph).toContain('concat=n=2:v=1:a=1[vcat][acat]');
    expect(graph).toContain('[acat]');
    expect(graph).toMatch(/\[acat\].*arnndn.*\[aout\]/);
  });

  it('resamples to 48kHz around the filter, the rate RNNoise expects', () => {
    const chain = buildDenoiseChain('/models/cb.rnnn');
    expect(chain).toBe(
      'highpass=f=80,aresample=48000,arnndn=m=/models/cb.rnnn,afftdn=nf=-45:nr=20,' +
        'volume=6dB,alimiter=limit=0.95,aresample=48000'
    );
  });

  it('cleans hard enough for footage that actually needs cleaning', () => {
    // -30 left a continuous broadband wash under the voice on real street
    // footage — audible to the person who recorded it, while the measured
    // noise floor looked fine, because that figure describes the pauses.
    //
    // Safe to push because denoising only runs when the measured headroom is
    // under 25dB (shouldDenoise), so a quiet recording never gets here.
    const chain = buildDenoiseChain('/models/cb.rnnn');
    expect(chain).toContain('afftdn=nf=-45:nr=20');
  });

  it('escapes a model path that would otherwise break the filter syntax', () => {
    // ':' separates filter options, so an unescaped path reads as "no such
    // filter" rather than as a missing file.
    const chain = buildDenoiseChain('/opt/models: v2/cb.rnnn');
    expect(chain).toContain('arnndn=m=/opt/models\\: v2/cb.rnnn');
  });

  it('still burns subtitles when denoising, since they share one pass', () => {
    const graph = buildConcatFilter(segments, '/tmp/captions.ass', '/models/cb.rnnn');
    expect(graph).toContain('ass=filename=/tmp/captions.ass');
    expect(graph).toContain('arnndn');
    expect(graph).toContain('[vout]');
  });
});

describe('pre-cleaned audio', () => {
  const segments = [{ start: 0, end: 2 }, { start: 5, end: 7 }];

  it('takes audio from the second input, video from the first', () => {
    const graph = buildConcatFilter(segments, undefined, undefined, true);
    // Video is always the source; the cleaned track has no picture.
    expect(graph).toContain('[0:v]trim=');
    expect(graph).toContain('[1:a]atrim=');
    expect(graph).not.toContain('[0:a]atrim=');
  });

  it('does not denoise twice', () => {
    // DeepFilterNet has already separated the speech. Running arnndn over its
    // output costs consonants and removes nothing that is left.
    const graph = buildConcatFilter(segments, undefined, '/models/bd.rnnn', true);
    expect(graph).not.toContain('arnndn');
    expect(graph).not.toContain('afftdn');
    // Levelling still happens — the cleaner returns a quieter track.
    expect(graph).toContain('volume=6dB');
    expect(graph).toContain('alimiter');
  });

  it('keeps the old in-graph chain when nothing was pre-cleaned', () => {
    const graph = buildConcatFilter(segments, undefined, '/models/bd.rnnn', false);
    expect(graph).toContain('arnndn=m=/models/bd.rnnn');
    expect(graph).toContain('[0:a]atrim=');
  });
});
