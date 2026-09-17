import { describe, expect, it } from 'vitest';
import {
  buildReconstructionPrompt,
  transcribeWithAudioModel,
  isPlausibleReconstruction,
  reconstructTranscript,
  type TranscriptVariant,
} from '../src/transcriptEnsemble';

const VARIANTS: TranscriptVariant[] = [
  { engine: 'whisper-1', text: 'ол мұшақ жүргерек өйбай енерге көтергерек' },
  { engine: 'gpt-4o-transcribe', text: 'ол мұқсат түргірік қойбай энергия көтергірік' },
];

function fakeFetch(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;
}

describe('buildReconstructionPrompt', () => {
  it('forbids inventing content, since captions are burned into the video', () => {
    const prompt = buildReconstructionPrompt(VARIANTS);
    expect(prompt).toContain('не придумывай');
    // Every variant has to reach the model — reconstruction works precisely
    // because the engines disagree.
    for (const v of VARIANTS) expect(prompt).toContain(v.text);
  });
});

describe('isPlausibleReconstruction', () => {
  it('accepts a repair that stays close to what was heard', () => {
    expect(isPlausibleReconstruction(VARIANTS, 'ол жүру керек қойбай энергия көтеру керек')).toBe(true);
  });

  it('accepts a shorter repair, since filler fragments get dropped', () => {
    expect(isPlausibleReconstruction(VARIANTS, 'энергия көтеру керек')).toBe(true);
  });

  it('rejects a fluent speech the model wrote by itself', () => {
    // The failure mode that matters: an eloquent fabrication is worse than a
    // rough transcript when it is burned into a client's video.
    const invented = Array.from({ length: 40 }, (_, i) => `сөз${i}`).join(' ');
    expect(isPlausibleReconstruction(VARIANTS, invented)).toBe(false);
  });

  it('rejects an empty result', () => {
    expect(isPlausibleReconstruction(VARIANTS, '   ')).toBe(false);
  });
});

describe('reconstructTranscript', () => {
  it('returns the repaired text when it stays faithful', async () => {
    const out = await reconstructTranscript(VARIANTS, 'k', fakeFetch('ол жүру керек қойбай энергия көтеру керек'));
    expect(out).toBe('ол жүру керек қойбай энергия көтеру керек');
  });

  it('refuses to repair a single transcript', async () => {
    // With nothing to compare against, "fixing" is just invention.
    let called = false;
    const spy = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await reconstructTranscript([VARIANTS[0]], 'k', spy)).toBeNull();
    expect(called).toBe(false);
  });

  it('discards a reconstruction that invented content', async () => {
    const invented = Array.from({ length: 60 }, (_, i) => `сөз${i}`).join(' ');
    expect(await reconstructTranscript(VARIANTS, 'k', fakeFetch(invented))).toBeNull();
  });

  it('surfaces an API failure rather than silently returning nothing', async () => {
    const failing = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(reconstructTranscript(VARIANTS, 'k', failing)).rejects.toThrow(/429/);
  });
});

describe('transcribeWithAudioModel', () => {
  it('sends the audio inline and asks for a text answer', async () => {
    let body: Record<string, unknown> = {};
    const spy = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Осы успешные адамдар' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await transcribeWithAudioModel('YXVkaW8=', 'mp3', 'k', spy);
    expect(out).toBe('Осы успешные адамдар');
    expect(body.modalities).toEqual(['text']);
    const content = (body.messages as Array<{ content: Array<{ type: string }> }>)[0].content;
    expect(content.map((c) => c.type)).toEqual(['text', 'input_audio']);
  });

  it('reads the transcript when the model answers in the audio field', async () => {
    const spy = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { audio: { transcript: 'сәлем' } } }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await transcribeWithAudioModel('YXVkaW8=', 'mp3', 'k', spy)).toBe('сәлем');
  });

  it('reports a failure instead of returning empty text', async () => {
    // Silently empty here would caption the video with whisper's nonsense and
    // call it a success.
    const spy = (async () => new Response('overloaded', { status: 503 })) as unknown as typeof fetch;
    await expect(transcribeWithAudioModel('YXVkaW8=', 'mp3', 'k', spy)).rejects.toThrow(/503/);
  });
});
