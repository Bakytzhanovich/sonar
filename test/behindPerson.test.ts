import { describe, it, expect } from 'vitest';
import { frameNeedsMask, maskInputSize, topOfPerson } from '../src/personMask';
import { buildBehindPersonFilter } from '../src/ffmpeg';
import { buildTopicEvents, buildTopicLayers, DEFAULT_TOPIC_LOOK, type CaptionMarkup } from '../src/topicLayout';
import { DEFAULT_SUBTITLE_STYLE, type SubtitleChunk } from '../src/subtitles';

describe('person mask helpers', () => {
  it('sizes the model input to the frame, short side 288, multiples of 32', () => {
    expect(maskInputSize({ width: 1080, height: 1920 })).toEqual({ width: 288, height: 512 });
    expect(maskInputSize({ width: 1920, height: 1080 })).toEqual({ width: 512, height: 288 });
    expect(maskInputSize({ width: 1080, height: 1080 })).toEqual({ width: 288, height: 288 });
  });

  it('masks only the frames where a keyword is up, with a frame of slack at each cut', () => {
    const windows = [{ start: 1, end: 2 }];
    expect(frameNeedsMask(0, 30, windows)).toBe(false);
    expect(frameNeedsMask(29, 30, windows)).toBe(true);
    expect(frameNeedsMask(45, 30, windows)).toBe(true);
    expect(frameNeedsMask(60, 30, windows)).toBe(true);
    expect(frameNeedsMask(62, 30, windows)).toBe(false);
  });

  it('finds the top of the person, ignoring a few stray pixels, and null for nobody', () => {
    const w = 100;
    const h = 10;
    const mask = new Uint8Array(w * h);
    mask[1 * w + 50] = 255; // one stray hair pixel
    for (let y = 4; y < h; y++) for (let x = 30; x < 70; x++) mask[y * w + x] = 255;
    expect(topOfPerson(mask, w, h)).toBe(4);
    expect(topOfPerson(new Uint8Array(w * h), w, h)).toBeNull();
  });

  it('draws the keywords between the picture and the speaker cut out by the mask', () => {
    const filter = buildBehindPersonFilter('/tmp/k.ass', { width: 1080, height: 1920 });
    expect(filter).toContain('[1:v]scale=1080:1920');
    expect(filter).toContain('[base]ass=filename=');
    expect(filter).toContain('[fga][mask]alphamerge[person]');
    expect(filter).toContain('[text][person]overlay');
  });
});

describe('Тема keywords as their own layer', () => {
  const style = { ...DEFAULT_SUBTITLE_STYLE, playResX: 1080, playResY: 1920, fontSize: 96, marginV: 300 };
  const measure = (text: string, size: number) => text.length * size * 0.5;
  const chunks: SubtitleChunk[] = [
    { start: 1, end: 3, words: [{ word: 'деньги', start: 1, end: 1.5 }, { word: 'любят', start: 1.5, end: 2 }, { word: 'счёт', start: 2, end: 3 }] },
    { start: 3, end: 6, words: [{ word: 'время', start: 3, end: 4 }, { word: 'дороже', start: 4, end: 6 }] },
  ];
  const markup: CaptionMarkup = {
    topics: [
      { from: 0, to: 0, keyword: 'деньги' },
      { from: 1, to: 1, keyword: 'время' },
    ],
    keyStart: [1, 1],
    accents: [],
  };
  const measures = { keyword: measure, key: measure };
  const posOf = (event: string) => event.match(/\\pos\((\d+),(\d+)\)/)!.slice(1).map(Number);
  const sizeOf = (event: string) => Number(event.match(/\\fs(\d+)/)![1]);

  it('splits out exactly the keywords, with their windows, and changes nothing else', () => {
    const layers = buildTopicLayers(chunks, markup, style, measures);
    expect(layers.keywords).toHaveLength(2);
    expect(layers.keywords[0]).toContain('ДЕНЬГИ');
    expect(layers.keywordWindows).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 6 },
    ]);
    // The keyword colour is the keywords' alone.
    expect(layers.captions.some((e) => e.includes(DEFAULT_TOPIC_LOOK.keywordColour))).toBe(false);
    expect(buildTopicEvents(chunks, markup, style, measures)).toEqual([...layers.keywords, ...layers.captions]);
  });

  it('puts the word on the top of the head and wider, where the mask found one', () => {
    const plain = buildTopicLayers(chunks, markup, style, measures).keywords;
    const behind = buildTopicLayers(chunks, markup, style, measures, undefined, { pictureTop: 0, hiddenUntil: 0, personTops: [700, null] }).keywords;
    expect(posOf(behind[0])[1]).toBe(700);
    expect(sizeOf(behind[0])).toBeGreaterThan(sizeOf(plain[0]));
    // Nobody in the second window: placed as without the option.
    expect(behind[1]).toBe(plain[1]);
  });

  it('never lifts the word out of the top of the picture', () => {
    const behind = buildTopicLayers(chunks, markup, style, measures, undefined, { pictureTop: 0, hiddenUntil: 0, personTops: [0, 0] }).keywords;
    const [, y] = posOf(behind[0]);
    expect(y - (sizeOf(behind[0]) * 0.75) / 2).toBeGreaterThan(0);
  });
});
