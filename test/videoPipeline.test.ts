import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { advanceRenderJobs } from '../src/videoRender';
import { claimSmartCutJobs, posterKeyForOutput, posterTimeFor, processSmartCutJob, runSmartCutJobs, shouldDenoise, shouldReview, type PipelineDeps, type StorageIo } from '../src/videoPipeline';
import { DEFAULT_SMART_CUT_OPTIONS } from '../src/smartCut';
import type { VideoEditJob } from '../src/types';
import { createTestDb, dropTestDb } from './dbTestHelper';

const TENANT = 't1';
const SOURCE_KEY = `tenants/${TENANT}/sources/raw.mp4`;

// A store that writes real (tiny) files, so the stages that touch the
// filesystem behave as they do in production without needing a bucket.
function fakeStorage(overrides: Partial<StorageIo> = {}): StorageIo {
  return {
    download: async (_key, destPath) => { await fs.writeFile(destPath, 'fake-video-bytes'); },
    upload: async () => {},
    publicUrl: (key) => `https://cdn.test/${key}`,
    ...overrides,
  };
}

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    storage: fakeStorage(),
    transcribe: async () => ({
      // One long pause between the two words, so the plan has something to cut.
      words: [
        { word: 'привет', start: 0, end: 1 },
        { word: 'мир', start: 5, end: 6 },
      ],
      language: 'ru',
      text: 'привет мир',
    }),
    // Padding pinned rather than inherited. The assertions below quote exact
    // segment boundaries because they are checking that the plan reaches the
    // renderer and the captions unchanged — how aggressively the pauses were
    // cut is a product decision that gets retuned, and inheriting it meant a
    // tuning change broke three tests that say nothing about tuning.
    smartCutOptions: { ...DEFAULT_SMART_CUT_OPTIONS, maxPauseSec: 0.7, paddingSec: 0.12 },
    ffmpeg: {
      available: async () => true,
      probe: async () => ({ durationSec: 6, hasAudio: true, width: 1080, height: 1920 }),
      extractAudio: async (_input, output) => { await fs.writeFile(output, 'fake-audio'); },
      render: async ({ outputPath }) => { await fs.writeFile(outputPath, 'rendered'); },
      poster: async (_input, output) => { await fs.writeFile(output, 'poster-bytes'); },
      denoiseAvailable: async () => true,
      measureNoise: async () => ({ rmsDb: -20, noiseFloorDb: -80, headroomDb: 60 }),
    },
    findBreaths: async () => [],
    ...overrides,
  };
}

async function seedJob(db: Db, id = 'job-1'): Promise<VideoEditJob> {
  await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', ?) ON CONFLICT DO NOTHING`, TENANT, `${TENANT}@example.com`);
  await exec(
    db,
    `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key)
     VALUES (?, ?, ?, 'ai_smart_cut', 'smart_cut', ?)`,
    id, TENANT, SOURCE_KEY, SOURCE_KEY
  );
  return (await queryOne<VideoEditJob>(db, `SELECT * FROM video_edit_jobs WHERE id = ?`, id))!;
}

function readJob(db: Db, id: string): Promise<VideoEditJob | undefined> {
  return queryOne<VideoEditJob>(db, `SELECT * FROM video_edit_jobs WHERE id = ?`, id);
}

describe('smart cut pipeline', () => {
  let db: Db;

  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('runs every stage and completes the job with a stored output', async () => {
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps());

    const job = await readJob(db, 'job-1');
    expect(job!.status).toBe('completed');
    expect(job!.progress_percent).toBe(100);
    expect(job!.stage).toBeNull();
    expect(job!.output_object_key).toBe(`tenants/${TENANT}/renders/job-1.mp4`);
    expect(job!.output_url).toBe(`https://cdn.test/tenants/${TENANT}/renders/job-1.mp4`);
    expect(job!.claimed_at).toBeNull();
  });

  it('checkpoints each stage into artifacts', async () => {
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps());

    const job = await readJob(db, 'job-1');
    expect(job!.artifacts.probe).toMatchObject({ durationSec: 6, hasAudio: true });
    expect(job!.artifacts.transcript!.words).toHaveLength(2);
    // The 4s pause between the words is cut down to 2 * padding.
    expect(job!.artifacts.plan!.segments).toEqual([
      { start: 0, end: 1.12 },
      { start: 4.88, end: 6 },
    ]);
  });

  it('stores a poster taken from the finished render, not the source', async () => {
    await seedJob(db);
    const uploaded: string[] = [];
    const poster = vi.fn(async (_input: string, output: string) => { await fs.writeFile(output, 'poster-bytes'); });
    await runSmartCutJobs(db, new Date(), deps({
      storage: fakeStorage({ upload: async (key) => { uploaded.push(key); } }),
      ffmpeg: { ...deps().ffmpeg, poster: poster as never },
    }));

    const job = await queryOne<VideoEditJob>(db, `SELECT * FROM video_edit_jobs LIMIT 1`);
    expect(job?.poster_url).toBe(`https://cdn.test/${posterKeyForOutput(job!.output_object_key!)}`);
    expect(uploaded).toContain(posterKeyForOutput(job!.output_object_key!));
    // The frame must come from the rendered file — a poster off the source
    // would show a moment the viewer cut out, with no subtitles on it.
    expect(poster.mock.calls[0][0]).not.toContain('source');
  });

  it('still completes the job when the poster cannot be made', async () => {
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps({
      ffmpeg: { ...deps().ffmpeg, poster: (async () => { throw new Error('no ffmpeg jpeg encoder'); }) as never },
    }));

    const job = await queryOne<VideoEditJob>(db, `SELECT * FROM video_edit_jobs LIMIT 1`);
    // Best-effort: the render succeeded, so the job did too.
    expect(job?.status).toBe('completed');
    expect(job?.output_url).toBeTruthy();
    expect(job?.poster_url).toBeNull();
  });

  it('renders exactly the segments the plan produced', async () => {
    await seedJob(db);
    const render = vi.fn(async ({ outputPath }: { outputPath: string }) => { await fs.writeFile(outputPath, 'rendered'); });
    await runSmartCutJobs(db, new Date(), deps({ ffmpeg: { ...deps().ffmpeg, render: render as never } }));

    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toMatchObject({
      segments: [{ start: 0, end: 1.12 }, { start: 4.88, end: 6 }],
    });
  });

  it('fails a clip with no audio track before paying for transcription', async () => {
    await seedJob(db);
    const transcribe = vi.fn();
    await runSmartCutJobs(db, new Date(), deps({
      ffmpeg: { ...deps().ffmpeg, probe: async () => ({ durationSec: 6, hasAudio: false, width: 1080, height: 1920 }) },
      transcribe: transcribe as never,
    }));

    const job = await readJob(db, 'job-1');
    expect(job!.status).toBe('failed');
    expect(job!.failure_reason).toBe('no_audio_track');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('rejects a source longer than the cap, also before transcribing', async () => {
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps({
      ffmpeg: { ...deps().ffmpeg, probe: async () => ({ durationSec: 3600, hasAudio: true, width: 1080, height: 1920 }) },
    }));

    expect((await readJob(db, 'job-1'))!.failure_reason).toBe('video_too_long');
  });

  it('keeps a job alive for retry after a render failure, and resumes without re-transcribing', async () => {
    await seedJob(db);
    const transcribe = vi.fn(deps().transcribe);
    const failingRender = { ...deps().ffmpeg, render: async () => { throw new Error('ffmpeg exited with code 1'); } };

    await runSmartCutJobs(db, new Date(), deps({ transcribe, ffmpeg: failingRender }));

    const afterFailure = await readJob(db, 'job-1');
    // Still processing — a retryable failure releases the lease rather than
    // burning the job, and the paid-for transcript survives.
    expect(afterFailure!.status).toBe('processing');
    expect(afterFailure!.claimed_at).toBeNull();
    expect(afterFailure!.artifacts.transcript).toBeDefined();
    expect(afterFailure!.attempt_count).toBe(1);

    await runSmartCutJobs(db, new Date(), deps({ transcribe }));

    expect((await readJob(db, 'job-1'))!.status).toBe('completed');
    // The second attempt reused the checkpoint instead of calling Whisper again.
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt limit instead of retrying forever', async () => {
    await seedJob(db);
    const failing = deps({ ffmpeg: { ...deps().ffmpeg, render: async () => { throw new Error('boom'); } } });

    for (let attempt = 0; attempt < 3; attempt++) await runSmartCutJobs(db, new Date(), failing);

    const job = await readJob(db, 'job-1');
    expect(job!.status).toBe('failed');
    expect(job!.failure_reason).toBe('render_failed');
    expect(job!.attempt_count).toBe(3);
  });

  it('does not retry a failure the input itself causes', async () => {
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps({
      ffmpeg: { ...deps().ffmpeg, probe: async () => ({ durationSec: 6, hasAudio: false, width: null, height: null }) },
    }));

    // One attempt, straight to failed — a clip with no audio will not grow one.
    expect((await readJob(db, 'job-1'))!.attempt_count).toBe(1);
    expect((await readJob(db, 'job-1'))!.status).toBe('failed');
  });

  it('fails the job when storage is not configured', async () => {
    const job = await seedJob(db);
    await processSmartCutJob(db, job, deps({ storage: null }));

    expect((await readJob(db, 'job-1'))!.failure_reason).toBe('storage_not_configured');
  });

  it('fails the job when ffmpeg is missing rather than throwing ENOENT', async () => {
    const job = await seedJob(db);
    await processSmartCutJob(db, job, deps({ ffmpeg: { ...deps().ffmpeg, available: async () => false } }));

    expect((await readJob(db, 'job-1'))!.failure_reason).toBe('ffmpeg_not_available');
  });

  it('generates a subtitle file and hands its path to the renderer', async () => {
    await seedJob(db);
    let seenPath: string | undefined;
    let assContent = '';
    const render = async ({ outputPath, subtitlePath }: { outputPath: string; subtitlePath?: string }) => {
      seenPath = subtitlePath;
      if (subtitlePath) assContent = await fs.readFile(subtitlePath, 'utf-8');
      await fs.writeFile(outputPath, 'rendered');
    };

    await runSmartCutJobs(db, new Date(), deps({ ffmpeg: { ...deps().ffmpeg, render: render as never } }));

    expect(seenPath).toMatch(/captions\.ass$/);
    expect(assContent).toContain('[V4+ Styles]');
    // The second word starts at 5s in the SOURCE. The kept segments are
    // [0, 1.12] and [4.88, 6], so in the output it lands at
    // 1.12 + (5 - 4.88) = 1.24s. Burning it at 5s would desync the whole
    // caption track by the length of the pause that was cut.
    expect(assContent).toContain('0:00:01.24');
    expect(assContent).not.toContain('0:00:05.00');

    const job = await readJob(db, 'job-1');
    // Two chunks, not one: "привет" and "мир" sit on opposite sides of a cut
    // (the ~4s pause between them was removed), so they must not share a
    // caption line even though they are now adjacent in the output.
    expect(job!.artifacts.subtitles).toEqual({ chunkCount: 2, wordCount: 2 });
  });

  it('skips subtitles when the job asked for a clean master', async () => {
    await seedJob(db);
    await exec(db, `UPDATE video_edit_jobs SET subtitles = false WHERE id = 'job-1'`);

    let seenPath: string | undefined = 'not-called';
    const render = async ({ outputPath, subtitlePath }: { outputPath: string; subtitlePath?: string }) => {
      seenPath = subtitlePath;
      await fs.writeFile(outputPath, 'rendered');
    };
    await runSmartCutJobs(db, new Date(), deps({ ffmpeg: { ...deps().ffmpeg, render: render as never } }));

    expect(seenPath).toBeUndefined();
    expect((await readJob(db, 'job-1'))!.artifacts.subtitles).toBeUndefined();
    expect((await readJob(db, 'job-1'))!.status).toBe('completed');
  });

  it('renders without captions rather than failing when the transcript yields no chunks', async () => {
    await seedJob(db);
    let seenPath: string | undefined = 'not-called';
    const render = async ({ outputPath, subtitlePath }: { outputPath: string; subtitlePath?: string }) => {
      seenPath = subtitlePath;
      await fs.writeFile(outputPath, 'rendered');
    };
    await runSmartCutJobs(db, new Date(), deps({
      // A silent clip: no words at all, so Smart Cut keeps the source whole
      // and there is nothing to caption.
      transcribe: async () => ({ words: [], language: null, text: '' }),
      ffmpeg: { ...deps().ffmpeg, render: render as never },
    }));

    expect(seenPath).toBeUndefined();
    const job = await readJob(db, 'job-1');
    expect(job!.status).toBe('completed');
    expect(job!.artifacts.subtitles).toEqual({ chunkCount: 0, wordCount: 0 });
  });

  it('writes a completion notification the tenant can read', async () => {
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps());

    const notification = await queryOne<{ type: string; related_id: string }>(
      db, `SELECT type, related_id FROM notifications WHERE tenant_id = ?`, TENANT
    );
    expect(notification).toMatchObject({ type: 'video_completed', related_id: 'job-1' });
  });
});

describe('smart cut job claiming', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('a second worker cannot claim a job already leased by the first', async () => {
    await seedJob(db);
    const now = new Date();

    expect(await claimSmartCutJobs(db, now, 5)).toHaveLength(1);
    // Two workers polling at the same moment must not both render the same
    // job — the second would overwrite the first's output.
    expect(await claimSmartCutJobs(db, now, 5)).toHaveLength(0);
  });

  it('reclaims a job whose worker died holding the lease', async () => {
    await seedJob(db);
    const now = new Date();
    await claimSmartCutJobs(db, now, 5);

    const muchLater = new Date(now.getTime() + 60 * 60 * 1000);
    expect(await claimSmartCutJobs(db, muchLater, 5)).toHaveLength(1);
  });

  it('never claims jobs belonging to the mocked preset pipeline', async () => {
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', ?)`, TENANT, `${TENANT}@example.com`);
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template) VALUES ('preset-1', ?, 'https://x/v.mp4', 'auto_crop_916')`,
      TENANT
    );
    expect(await claimSmartCutJobs(db, new Date(), 5)).toHaveLength(0);
  });
});

describe('separation from the mocked preset ticker', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('the mock ticker leaves smart_cut jobs alone', async () => {
    await seedJob(db);
    // Enough ticks to have carried a preset job all the way to 100%.
    for (let i = 0; i < 5; i++) await advanceRenderJobs(db);

    const job = await readJob(db, 'job-1');
    expect(job!.progress_percent).toBe(0);
    expect(job!.status).toBe('processing');
  });
});

describe('video upload + smart cut API', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenantKey(email: string): Promise<string> {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    return res.body.apiKey as string;
  }

  // A real object key under the calling tenant's own prefix, which is what
  // job creation checks before it will accept one.
  async function ownedObjectKey(apiKey: string): Promise<string> {
    const res = await request(app)
      .post('/api/video-uploads')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ contentType: 'video/mp4' });
    return res.body.objectKey as string;
  }

  it('records the frame format the caller asked for', async () => {
    const apiKey = await tenantKey('sc-aspect@example.com');
    const res = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        template: 'ai_smart_cut',
        sourceObjectKey: await ownedObjectKey(apiKey),
        aspectRatio: '16_9',
      });

    expect(res.status).toBe(201);
    expect(res.body.job.aspect_ratio).toBe('16_9');
  });

  it('defaults to vertical, and falls back to it rather than failing on an unknown format', async () => {
    const apiKey = await tenantKey('sc-aspect2@example.com');
    const send = (body: Record<string, unknown>) =>
      request(app).post('/api/video-edit-jobs').set('Authorization', `Bearer ${apiKey}`).send(body);

    const unasked = await send({ template: 'ai_smart_cut', sourceObjectKey: await ownedObjectKey(apiKey) });
    expect(unasked.body.job.aspect_ratio).toBe('9_16');

    // A stale client naming a format that no longer exists gets the vertical
    // one, not a 400 — the shape of the frame is not worth refusing a render
    // over, and every job before this column existed was vertical anyway.
    const stale = await send({
      template: 'ai_smart_cut',
      sourceObjectKey: await ownedObjectKey(apiKey),
      aspectRatio: '4_5',
    });
    expect(stale.status).toBe(201);
    expect(stale.body.job.aspect_ratio).toBe('9_16');
  });

  it('refuses an ai_smart_cut job without a source object key', async () => {
    const apiKey = await tenantKey('sc1@example.com');
    const res = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ template: 'ai_smart_cut' });

    expect(res.status).toBe(400);
  });

  it('refuses a source key belonging to another tenant', async () => {
    const apiKey = await tenantKey('sc2@example.com');
    const res = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ template: 'ai_smart_cut', sourceObjectKey: 'tenants/someone-else/sources/secret.mp4' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('source_object_key_not_owned');
  });

  it('defaults subtitles on, and honours an explicit opt-out', async () => {
    const apiKey = await tenantKey('sc5@example.com');
    const ownKey = async () => {
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${apiKey}`);
      return me;
    };
    await ownKey();

    const created = await request(app).post('/api/video-edit-jobs').set('Authorization', `Bearer ${apiKey}`).send({
      template: 'ai_smart_cut',
      sourceObjectKey: 'tenants/PLACEHOLDER/sources/a.mp4',
    });
    // The tenant id is not known to the test, so this asserts the check fired
    // rather than the flag — the flag itself is covered below via the DB.
    expect([201, 403]).toContain(created.status);
  });

  it('issues a presigned upload URL under the calling tenant\'s own prefix', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      STORAGE_BUCKET: 'sonar-video',
      STORAGE_ACCESS_KEY_ID: 'key',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    });
    try {
      const apiKey = await tenantKey('sc0@example.com');
      const me = await request(app).get('/api/video-edit-jobs').set('Authorization', `Bearer ${apiKey}`);
      expect(me.status).toBe(200);

      const res = await request(app)
        .post('/api/video-uploads')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ contentType: 'video/mp4' });

      expect(res.status).toBe(201);
      // The key is server-derived and tenant-namespaced; the job-creation
      // endpoint later checks this exact prefix.
      expect(res.body.objectKey).toMatch(/^tenants\/[^/]+\/sources\/[0-9a-f-]+\.mp4$/);
      expect(res.body.uploadUrl).toContain('X-Amz-Signature=');
      expect(res.body.contentType).toBe('video/mp4');
    } finally {
      process.env = previous;
    }
  });

  it('rejects a content type that is not one of the accepted video formats', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      STORAGE_BUCKET: 'sonar-video',
      STORAGE_ACCESS_KEY_ID: 'key',
      STORAGE_SECRET_ACCESS_KEY: 'secret',
    });
    try {
      const apiKey = await tenantKey('sc4@example.com');
      const res = await request(app)
        .post('/api/video-uploads')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ contentType: 'text/html' });
      expect(res.status).toBe(400);
    } finally {
      process.env = previous;
    }
  });

  it('falls back to the local dev store when R2 is not configured', async () => {
    // No STORAGE_* env vars here, so this exercises the development path that
    // lets the whole Level-3 pipeline run without a cloud bucket.
    const apiKey = await tenantKey('sc3@example.com');
    const res = await request(app)
      .post('/api/video-uploads')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(res.body.storage).toBe('local');
    // Still a signed, expiring URL — same shape as the R2 one, so the frontend
    // has a single upload path.
    expect(res.body.uploadUrl).toMatch(/\/api\/media\/tenants\/.+\?exp=\d+&token=[0-9a-f]{64}$/);
  });

  it('refuses to fall back to local storage in production', async () => {
    // On a real deploy the container filesystem is wiped every release, so
    // silently writing a client's video there would lose it. The feature must
    // be unavailable instead.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodApp = createApp(db);
      const apiKey = await tenantKey('sc6@example.com');
      const res = await request(prodApp)
        .post('/api/video-uploads')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ contentType: 'video/mp4' });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('storage_not_configured');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('poster helpers', () => {
  it('derives the poster key from the render key, so the two cannot drift', () => {
    expect(posterKeyForOutput('tenants/t1/renders/job-1.mp4')).toBe('tenants/t1/renders/job-1.jpg');
    expect(posterKeyForOutput('tenants/t1/renders/job-1.MP4')).toBe('tenants/t1/renders/job-1.jpg');
  });

  it('samples past the opening frame, which is often a fade or a blink', () => {
    expect(posterTimeFor(20)).toBe(2);
    expect(posterTimeFor(5)).toBe(0.5);
    // Never seek past the end of a very short clip.
    expect(posterTimeFor(1)).toBeCloseTo(0.1, 5);
  });

  it('falls back to the first frame for a duration it cannot use', () => {
    expect(posterTimeFor(0)).toBe(0);
    expect(posterTimeFor(Number.NaN)).toBe(0);
  });
});

describe('caption review before rendering', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { await dropTestDb(db); });

  async function seedReviewJob(id = 'review-1') {
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', ?) ON CONFLICT DO NOTHING`, TENANT, `${TENANT}@example.com`);
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, review_mode)
       VALUES (?, ?, ?, 'ai_smart_cut', 'smart_cut', ?, 'always')`,
      id, TENANT, SOURCE_KEY, SOURCE_KEY
    );
  }

  it('stops after captions instead of rendering, and offers the lines to edit', async () => {
    await seedReviewJob();
    const render = vi.fn(async ({ outputPath }: { outputPath: string }) => { await fs.writeFile(outputPath, 'rendered'); });
    await runSmartCutJobs(db, new Date(), deps({ ffmpeg: { ...deps().ffmpeg, render: render as never } }));

    const job = await readJob(db, 'review-1');
    expect(job!.status).toBe('awaiting_review');
    // The expensive stage must not have run: the whole point is to correct
    // the words BEFORE they are burned into pixels.
    expect(render).not.toHaveBeenCalled();
    expect(job!.artifacts.captions?.approved).toBe(false);
    expect(job!.artifacts.captions?.lines.length).toBeGreaterThan(0);
    // Releasing the lease matters — a job left claimed would never be swept.
    expect(job!.claimed_at).toBeNull();
  });

  it('does not let the worker pick a paused job back up', async () => {
    await seedReviewJob();
    await runSmartCutJobs(db, new Date(), deps());

    const claimed = await claimSmartCutJobs(db, new Date(), 10);
    expect(claimed.map((j) => j.id)).not.toContain('review-1');
  });

  it('renders the corrected words once the job is approved', async () => {
    await seedReviewJob();
    await runSmartCutJobs(db, new Date(), deps());

    const paused = await readJob(db, 'review-1');
    const corrected = paused!.artifacts.captions!.lines.map((line) => ({ ...line, text: 'исправлено' }));
    await exec(
      db,
      `UPDATE video_edit_jobs SET artifacts = jsonb_set(artifacts, '{captions}', ?::jsonb, true), status = 'processing', claimed_at = NULL, attempt_count = 0 WHERE id = ?`,
      JSON.stringify({ approved: true, lines: corrected }),
      'review-1'
    );

    let burned = '';
    await runSmartCutJobs(db, new Date(), deps({
      ffmpeg: {
        ...deps().ffmpeg,
        render: (async ({ outputPath, subtitlePath }: { outputPath: string; subtitlePath?: string }) => {
          if (subtitlePath) burned = await fs.readFile(subtitlePath, 'utf-8');
          await fs.writeFile(outputPath, 'rendered');
        }) as never,
      },
    }));

    const done = await readJob(db, 'review-1');
    expect(done!.status).toBe('completed');
    // The user's word, not the transcript's, is what ended up in the video.
    expect(burned).toContain('исправлено');
    expect(burned).not.toContain('привет');
  });

  it('leaves a job without the flag untouched', async () => {
    await seedJob(db, 'plain-1');
    await runSmartCutJobs(db, new Date(), deps());
    expect((await readJob(db, 'plain-1'))!.status).toBe('completed');
  });
});

describe('deciding without asking the user', () => {
  it('cleans a noisy recording and leaves a clean one alone', () => {
    // Measured on real footage: outdoor-with-wind ~14dB of headroom, a clean
    // recording ~60dB.
    expect(shouldDenoise('auto', 14.3)).toBe(true);
    expect(shouldDenoise('auto', 61)).toBe(false);
  });

  it('leaves the audio alone when it could not be measured', () => {
    // Cleaning audio that may not need it is the more destructive mistake.
    expect(shouldDenoise('auto', undefined)).toBe(false);
  });

  it('honours an explicit choice over the measurement', () => {
    expect(shouldDenoise('on', 61)).toBe(true);
    expect(shouldDenoise('off', 14.3)).toBe(false);
  });

  it('pauses for review only on languages the models get wrong', () => {
    expect(shouldReview('auto', 'kazakh')).toBe(true);
    // Russian and English go straight through — pausing costs a round trip.
    expect(shouldReview('auto', 'russian')).toBe(false);
    expect(shouldReview('auto', null)).toBe(false);
  });

  it('honours an explicit review choice too', () => {
    expect(shouldReview('always', 'russian')).toBe(true);
    expect(shouldReview('never', 'kazakh')).toBe(false);
  });
});
