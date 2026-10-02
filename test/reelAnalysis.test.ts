import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import {
  analyzeReelTranscript,
  formatTimedTranscript,
  openAiChatFromEnv,
  parseReelAnalysis,
  parseScript,
  ReelAnalysisError,
  type ChatModel,
} from '../src/reelLlm';
import { MAX_REEL_SECONDS, runReelJobs, type ReelDeps } from '../src/reelPipeline';
import { TranscriptionError } from '../src/transcription';
import type { ReelAnalysis } from '../src/types';
import { createTestDb, dropTestDb } from './dbTestHelper';

const words = (...spec: Array<[string, number, number]>) => spec.map(([word, start, end]) => ({ word, start, end }));

const SPEECH = words(
  ['Ты', 0.2, 0.4], ['делаешь', 0.45, 0.9], ['это', 0.95, 1.1], ['неправильно', 1.15, 1.8],
  ['Вот', 3.0, 3.2], ['три', 3.25, 3.5], ['ошибки', 3.55, 4.0],
  ['Подписывайся', 12.0, 12.8],
);

const GOOD_ANSWER = JSON.stringify({
  hook: 'Обвинение зрителя в ошибке с первой секунды',
  structure: [
    { label: 'Хук', timestampSeconds: 0.2, summary: 'Говорит, что зритель ошибается' },
    { label: 'Список', timestampSeconds: 3.0, summary: 'Перечисляет три ошибки' },
    { label: 'Призыв', timestampSeconds: 12.0, summary: 'Просит подписаться' },
  ],
  why: 'Задевает зрителя лично, а список обещает конкретику.',
});

// ---- Pure: laying out the transcript, checking the answer -----------------

describe('formatTimedTranscript', () => {
  // The times are what let the model place the structure at real seconds of
  // the reel instead of making them up — which is what the old version did.
  it('stamps every line with when it starts', () => {
    const text = formatTimedTranscript(SPEECH);
    expect(text.split('\n')[0]).toBe('[00:00.2] Ты делаешь это неправильно');
  });

  it('breaks a line on a pause', () => {
    const lines = formatTimedTranscript(SPEECH).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('[00:03.0] Вот три ошибки');
    expect(lines[2]).toBe('[00:12.0] Подписывайся');
  });

  it('breaks an unbroken run of speech into readable lines', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ word: `с${i}`, start: i * 0.3, end: i * 0.3 + 0.25 }));
    expect(formatTimedTranscript(long).split('\n').length).toBeGreaterThan(1);
  });
});

describe('parseReelAnalysis', () => {
  it('reads a well-formed answer', () => {
    const a = parseReelAnalysis(GOOD_ANSWER, 15);
    expect(a.hook).toContain('Обвинение');
    expect(a.structure.map((b) => b.label)).toEqual(['Хук', 'Список', 'Призыв']);
    expect(a.why).toContain('список');
  });

  it('puts parts in order and keeps timestamps inside the reel', () => {
    const a = parseReelAnalysis(
      JSON.stringify({
        hook: 'h',
        structure: [
          { label: 'Конец', timestampSeconds: 99, summary: '' },
          { label: 'Начало', timestampSeconds: -3, summary: '' },
        ],
        why: '',
      }),
      20
    );
    expect(a.structure.map((b) => b.label)).toEqual(['Начало', 'Конец']);
    expect(a.structure[0].timestampSeconds).toBe(0);
    expect(a.structure[1].timestampSeconds).toBe(20);
  });

  // Not an analysis of a reel; saving it would put something made-up in
  // front of a client.
  it('refuses an answer without a hook or with fewer than two parts', () => {
    expect(() => parseReelAnalysis(JSON.stringify({ structure: [] }), 10)).toThrow(ReelAnalysisError);
    expect(() =>
      parseReelAnalysis(JSON.stringify({ hook: 'h', structure: [{ label: 'Один', timestampSeconds: 0 }] }), 10)
    ).toThrow(ReelAnalysisError);
  });

  it('refuses something that is not JSON', () => {
    expect(() => parseReelAnalysis('Конечно! Вот разбор…', 10)).toThrow(ReelAnalysisError);
  });
});

describe('parseScript', () => {
  it('reads the script and refuses an empty one', () => {
    expect(parseScript(JSON.stringify({ script: '  Хук: …  ' }))).toBe('Хук: …');
    expect(() => parseScript(JSON.stringify({ script: '' }))).toThrow(ReelAnalysisError);
  });
});

describe('analyzeReelTranscript', () => {
  it('gives the model the timed transcript and the length of the reel', async () => {
    const chat = vi.fn<ChatModel>(async () => GOOD_ANSWER);
    await analyzeReelTranscript(SPEECH, 15, chat);
    const userMessage = chat.mock.calls[0][1];
    expect(userMessage).toContain('[00:00.2] Ты делаешь это неправильно');
    expect(userMessage).toContain('15.0');
  });
});

describe('openAiChatFromEnv', () => {
  // The old module answered a missing key with a canned analysis. This one
  // says it cannot, so nobody is shown a fake.
  it('refuses without a key instead of inventing an answer', async () => {
    const chat = openAiChatFromEnv(undefined, (() => {
      throw new Error('must not reach the network');
    }) as unknown as typeof fetch);
    await expect(chat('s', 'u')).rejects.toMatchObject({ reason: 'llm_not_configured' });
  });
});

// ---- The worker pipeline ---------------------------------------------------

const TENANT = 'reel-tenant';
const SOURCE_KEY = `tenants/${TENANT}/sources/reel.mp4`;

function deps(overrides: Partial<ReelDeps> = {}): ReelDeps {
  return {
    storage: {
      download: async (_key, dest) => { await fs.writeFile(dest, 'video'); },
      upload: async () => {},
      remove: async () => {},
      publicUrl: (key) => `https://cdn.test/${key}`,
    },
    transcribe: async () => ({ words: SPEECH, text: SPEECH.map((w) => w.word).join(' '), language: 'ru' }),
    ffmpeg: {
      probe: async () => ({ durationSec: 15, hasAudio: true, width: 1080, height: 1920 }),
      // A distinct file per test run, so the transcript cache does not carry
      // one test's speech into the next.
      extractAudio: async (_input, output) => { await fs.writeFile(output, `audio-${Math.random()}`); },
    },
    chat: async () => GOOD_ANSWER,
    ...overrides,
  };
}

describe('reel pipeline', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', ?)`, TENANT, `${TENANT}@example.com`);
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function seed(id = 'r1'): Promise<void> {
    await exec(
      db,
      `INSERT INTO reel_analyses (id, tenant_id, source_object_key, status) VALUES (?, ?, ?, 'processing')`,
      id, TENANT, SOURCE_KEY
    );
  }
  const read = (id = 'r1') => queryOne<ReelAnalysis>(db, `SELECT * FROM reel_analyses WHERE id = ?`, id);

  it('transcribes, analyses and stores a real result', async () => {
    await seed();
    await runReelJobs(db, new Date(), deps());

    const row = await read();
    expect(row!.status).toBe('completed');
    expect(row!.hook).toContain('Обвинение');
    expect(row!.structure!.map((b) => b.label)).toEqual(['Хук', 'Список', 'Призыв']);
    expect(row!.why).toBeTruthy();
    expect(row!.transcript).toHaveLength(SPEECH.length);
    expect(row!.duration_seconds).toBe(15);
    expect(row!.claimed_at).toBeNull();
  });

  // Checked before anything is paid for.
  it('fails a silent clip without transcribing it', async () => {
    await seed();
    const transcribe = vi.fn();
    await runReelJobs(db, new Date(), deps({
      transcribe,
      ffmpeg: { ...deps().ffmpeg, probe: async () => ({ durationSec: 15, hasAudio: false, width: 1, height: 1 }) },
    }));
    expect((await read())!.failure_reason).toBe('no_audio_track');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('refuses something far longer than a reel before paying for it', async () => {
    await seed();
    const transcribe = vi.fn();
    await runReelJobs(db, new Date(), deps({
      transcribe,
      ffmpeg: { ...deps().ffmpeg, probe: async () => ({ durationSec: MAX_REEL_SECONDS + 60, hasAudio: true, width: 1, height: 1 }) },
    }));
    expect((await read())!.status).toBe('failed');
    expect((await read())!.failure_reason).toBe('video_too_long');
    expect(transcribe).not.toHaveBeenCalled();
  });

  // Music under a dance: a model asked for the spoken mechanic would invent one.
  it('says there is no speech rather than asking the model to imagine some', async () => {
    await seed();
    const chat = vi.fn<ChatModel>(async () => GOOD_ANSWER);
    await runReelJobs(db, new Date(), deps({
      chat,
      transcribe: async () => ({ words: words(['ля', 0, 1]), text: 'ля', language: 'ru' }),
    }));
    expect((await read())!.failure_reason).toBe('no_speech');
    expect(chat).not.toHaveBeenCalled();
  });

  it('fails at once when no model is configured — retrying cannot fix that', async () => {
    await seed();
    await runReelJobs(db, new Date(), deps({ chat: openAiChatFromEnv(undefined) }));
    const row = await read();
    expect(row!.status).toBe('failed');
    expect(row!.failure_reason).toBe('llm_not_configured');
  });

  it('retries a model that answered nonsense, then gives up', async () => {
    await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bad = deps({ chat: async () => 'не JSON' });
      await runReelJobs(db, new Date(), bad);
      expect((await read())!.status).toBe('processing');
      await runReelJobs(db, new Date(), bad);
      await runReelJobs(db, new Date(), bad);
      expect((await read())!.status).toBe('failed');
      expect((await read())!.failure_reason).toBe('llm_invalid_answer');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a transcription failure retryable', async () => {
    await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runReelJobs(db, new Date(), deps({
        transcribe: async () => { throw new TranscriptionError('transcription_failed', 'boom'); },
      }));
    } finally {
      warn.mockRestore();
    }
    const row = await read();
    expect(row!.status).toBe('processing');
    expect(row!.claimed_at).toBeNull();
  });

  // The same audio is not paid for twice: a second analysis of the same file
  // reads the transcript back from the cache the video pipeline also fills.
  it('does not transcribe the same audio twice', async () => {
    await seed('a');
    await seed('b');
    const transcribe = vi.fn(async () => ({ words: SPEECH, text: 'x', language: 'ru' }));
    const sameAudio = deps({
      transcribe,
      ffmpeg: { ...deps().ffmpeg, extractAudio: async (_i, out) => { await fs.writeFile(out, 'identical-audio'); } },
    });
    await runReelJobs(db, new Date(), sameAudio);
    await runReelJobs(db, new Date(), sameAudio);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect((await read('b'))!.status).toBe('completed');
  });
});

// ---- The API ---------------------------------------------------------------

describe('reel analysis API', () => {
  let app: Express;
  let db: Db;
  let chat: ChatModel;

  beforeEach(async () => {
    db = await createTestDb();
    chat = async () => JSON.stringify({ script: 'Хук: Ты неправильно тренируешься…' });
    app = createApp(db, { reelChat: (s, u) => chat(s, u) });
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenant(email: string) {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    const id = (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
    return { apiKey: res.body.apiKey as string, id };
  }

  async function finished(tenantId: string, id = 'done'): Promise<void> {
    await exec(
      db,
      `INSERT INTO reel_analyses (id, tenant_id, status, hook, structure, why, duration_seconds)
       VALUES (?, ?, 'completed', 'Хук', ?::jsonb, 'Почему', 15)`,
      id,
      tenantId,
      JSON.stringify([{ label: 'Хук', timestampSeconds: 0, summary: 's' }, { label: 'Призыв', timestampSeconds: 10, summary: 's' }])
    );
  }

  it('creates a processing analysis from an uploaded file', async () => {
    const t = await tenant('up@example.com');
    const res = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${t.apiKey}`)
      .send({ sourceObjectKey: `tenants/${t.id}/sources/x.mp4` });

    expect(res.status).toBe(201);
    expect(res.body.analysis.status).toBe('processing');

    const list = await request(app).get('/api/reel-analyses').set('Authorization', `Bearer ${t.apiKey}`);
    expect(list.body.analyses).toHaveLength(1);
  });

  it('requires a file', async () => {
    const t = await tenant('nofile@example.com');
    const res = await request(app).post('/api/reel-analyses').set('Authorization', `Bearer ${t.apiKey}`).send({});
    expect(res.status).toBe(400);
  });

  // Multi-tenancy isolation: a key from another tenant's prefix would have
  // the worker transcribe someone else's footage and hand the words back.
  it('refuses a file that belongs to another tenant', async () => {
    const t = await tenant('mine@example.com');
    const res = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${t.apiKey}`)
      .send({ sourceObjectKey: 'tenants/someone-else/sources/x.mp4' });
    expect(res.status).toBe(403);
  });

  it('adapts a finished analysis to a niche with the real model', async () => {
    const t = await tenant('script@example.com');
    await finished(t.id);
    const res = await request(app)
      .post('/api/reel-analyses/done/scripts')
      .set('Authorization', `Bearer ${t.apiKey}`)
      .send({ niche: 'фитнес' });

    expect(res.status).toBe(201);
    expect(res.body.script.script_text).toContain('тренируешься');

    const found = await request(app).get('/api/scripts?niche=фитнес').set('Authorization', `Bearer ${t.apiKey}`);
    expect(found.body.scripts).toHaveLength(1);
  });

  it('refuses a script for an analysis that is not finished', async () => {
    const t = await tenant('early@example.com');
    await exec(db, `INSERT INTO reel_analyses (id, tenant_id, status) VALUES ('wip', ?, 'processing')`, t.id);
    const res = await request(app)
      .post('/api/reel-analyses/wip/scripts')
      .set('Authorization', `Bearer ${t.apiKey}`)
      .send({ niche: 'фитнес' });
    expect(res.status).toBe(409);
  });

  // A canned script presented as adapted is what this module stopped doing.
  it('says the model failed instead of returning a template', async () => {
    const t = await tenant('fail@example.com');
    await finished(t.id);
    chat = async () => { throw new ReelAnalysisError('llm_failed', 'down'); };
    const res = await request(app)
      .post('/api/reel-analyses/done/scripts')
      .set('Authorization', `Bearer ${t.apiKey}`)
      .send({ niche: 'фитнес' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('llm_failed');
  });

  it('one tenant cannot see or generate scripts for another tenant\'s analysis', async () => {
    const owner = await tenant('owner-reels@example.com');
    const intruder = await tenant('intruder-reels@example.com');
    await finished(owner.id);

    const readRes = await request(app).get('/api/reel-analyses/done').set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(readRes.status).toBe(404);

    const write = await request(app)
      .post('/api/reel-analyses/done/scripts')
      .set('Authorization', `Bearer ${intruder.apiKey}`)
      .send({ niche: 'фитнес' });
    expect(write.status).toBe(404);
  });
});
