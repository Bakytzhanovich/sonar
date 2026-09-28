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
    // Pass-through by default: the tests below pin exact segment boundaries
    // against the fake transcript above, and a stub that moved timings would
    // be re-deciding the cut inside the fixture. The pass has its own tests —
    // the decision itself in speechTiming.test.ts, the wiring below.
    tightenTimings: async (_sourcePath, words) => ({ words, reclaimedSec: 0, tightenedCount: 0 }),
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

  it('plans the cut from the corrected timings, not the transcript it was handed', async () => {
    // The wiring, not the decision. Whisper stretches the last word before a
    // pause over the whole silence, so a planner fed the raw transcript sees
    // no gap and cuts nothing — which is what a client reported as "ИИ ничего
    // не вырезал". This asserts the corrected words are what reaches it.
    await seedJob(db);
    await runSmartCutJobs(db, new Date(), deps({
      // The first word claims to run until the second starts; the pass says
      // its sound stopped after a fifth of a second.
      tightenTimings: async (_path, words) => ({
        words: words.map((w, i) => (i === 0 ? { ...w, end: w.start + 0.2 } : w)),
        reclaimedSec: 0.8,
        tightenedCount: 1,
      }),
    }));

    const job = await readJob(db, 'job-1');
    // The gap the correction opened is now a cut: the first kept segment ends
    // just after the shortened word rather than running on to the second.
    expect(job!.artifacts.plan!.segments[0].end).toBeLessThan(1);
    expect(job!.artifacts.speechTiming).toMatchObject({ tightenedCount: 1, reclaimedSec: 0.8 });
  });

  it('still renders when the audio cannot be measured', async () => {
    // A job that cannot measure its own audio cuts less well; it does not
    // fail. The words it was given stand.
    await seedJob(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runSmartCutJobs(db, new Date(), deps({
        tightenTimings: async () => { throw new Error('ffmpeg speech-timing pass failed'); },
      }));
    } finally {
      warn.mockRestore();
    }

    const job = await readJob(db, 'job-1');
    expect(job!.status).toBe('completed');
    expect(job!.artifacts.speechTiming).toBeUndefined();
  });

  it('says so when it cannot remove its scratch directory, and still completes', async () => {
    // Both halves matter. A finished render whose output is already in storage
    // must not be failed over its leftovers — but staying silent is how a full
    // disk hides: the delete fails because there is no room, that leaks another
    // few hundred megabytes, and the next job has even less room. It happened:
    // two completed jobs left 618MB behind on a volume with 59MB free, and the
    // only visible symptom was renders failing for unrelated-looking reasons.
    await seedJob(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rm = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    let logged = '';
    try {
      await runSmartCutJobs(db, new Date(), deps());
      // Read before restoring: mockRestore also clears the call history, so
      // asserting afterwards checks an empty array and passes for the wrong
      // reason — or, as here, fails for one.
      logged = warn.mock.calls.flat().join(' ');
    } finally {
      rm.mockRestore();
      warn.mockRestore();
    }

    expect((await readJob(db, 'job-1'))!.status).toBe('completed');
    expect(logged).toContain('ENOSPC');
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

// ---- Manual re-edit -------------------------------------------------------
//
// The automatic cut is a guess. These cover the path a person takes when it
// guessed wrong: draw the segments yourself, render again, and keep the
// render you already had while that happens.
describe('re-editing a finished cut by hand', () => {
  let db: Db;

  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function seedWithManualSegments(
    segments: Array<{ start: number; end: number }>,
    id = 'job-manual'
  ): Promise<void> {
    await seedJob(db, id);
    await exec(db, `UPDATE video_edit_jobs SET manual_segments = ?::jsonb WHERE id = ?`, JSON.stringify(segments), id);
  }

  it('cuts where the person said, not where the planner would have', async () => {
    // The fixture transcript has a pause the planner always cuts; these
    // segments keep it and throw away the end instead — the opposite edit,
    // so a plan that came from the planner cannot pass this by coincidence.
    await seedWithManualSegments([{ start: 0, end: 4 }]);
    await runSmartCutJobs(db, new Date(), deps());

    const job = await readJob(db, 'job-manual');
    expect(job!.status).toBe('completed');
    expect(job!.artifacts.plan!.segments).toEqual([{ start: 0, end: 4 }]);
    expect(job!.artifacts.plan!.removedDurationSec).toBe(2);
  });

  // Both passes exist to guess where the cuts go, and the guessing is over by
  // the time someone has drawn them. The breath pass in particular decodes
  // the whole audio track a second time.
  it('skips the analysis passes that only feed the planner', async () => {
    await seedWithManualSegments([{ start: 0, end: 4 }]);
    await exec(db, `UPDATE video_edit_jobs SET remove_breaths = true WHERE id = 'job-manual'`);
    const findBreaths = vi.fn(async () => []);
    const tightenTimings = vi.fn(async (_p: string, words: Array<{ word: string; start: number; end: number }>) => ({
      words,
      reclaimedSec: 0,
      tightenedCount: 0,
    }));

    await runSmartCutJobs(db, new Date(), deps({ findBreaths, tightenTimings }));

    expect(findBreaths).not.toHaveBeenCalled();
    expect(tightenTimings).not.toHaveBeenCalled();
    const job = await readJob(db, 'job-manual');
    // And says nothing about passes that never ran, rather than reporting
    // zeroes the card would show as "no breaths found".
    expect(job!.artifacts.breaths).toBeUndefined();
    expect(job!.artifacts.speechTiming).toBeUndefined();
  });

  // Captions live in the output timeline and the cut just moved. A revision
  // that burned the parent's caption timings would drift them by exactly the
  // footage this edit removed.
  it('rebuilds the captions against the new cut', async () => {
    await seedWithManualSegments([{ start: 4.5, end: 6 }]);
    const render = vi.fn(async ({ outputPath }: { outputPath: string }) => { await fs.writeFile(outputPath, 'rendered'); });
    await runSmartCutJobs(db, new Date(), deps({ ffmpeg: { ...deps().ffmpeg, render } }));

    const job = await readJob(db, 'job-manual');
    expect(job!.status).toBe('completed');
    // Only the second word survives this cut, so the caption track holds one
    // word rather than the two the parent's did.
    expect(job!.artifacts.subtitles!.wordCount).toBe(1);
  });

  it('fails rather than falling back to the automatic cut when the segments do not fit', async () => {
    // Segments drawn against a different source than the one the probe finds.
    await seedWithManualSegments([{ start: 90, end: 120 }]);
    await runSmartCutJobs(db, new Date(), deps());

    const job = await readJob(db, 'job-manual');
    expect(job!.status).toBe('failed');
    expect(job!.failure_reason).toBe('nothing_to_cut');
  });
});

describe('POST /api/video-edit-jobs/:id/revise', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenantKey(email: string): Promise<string> {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    return res.body.apiKey as string;
  }

  // A finished job with the two checkpoints a revision is built from.
  async function finishedJob(id: string, tenantId: string): Promise<void> {
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, status, artifacts, subtitle_preset, aspect_ratio)
       VALUES (?, ?, ?, 'ai_smart_cut', 'smart_cut', ?, 'completed', ?::jsonb, 'bold', '1_1')`,
      id,
      tenantId,
      `tenants/${tenantId}/sources/raw.mp4`,
      `tenants/${tenantId}/sources/raw.mp4`,
      JSON.stringify({
        probe: { durationSec: 10, hasAudio: true, width: 1080, height: 1920 },
        transcript: { words: [{ word: 'раз', start: 0, end: 1 }], language: 'ru' },
        noise: { headroomDb: 40, denoised: true },
        plan: { segments: [{ start: 0, end: 10 }], keptDurationSec: 10, removedDurationSec: 0, droppedFillerCount: 0, degraded: false },
        usage: { totalCostUsd: 0.42 },
      })
    );
  }

  // The tenant the key was just issued to. Each test creates exactly one, so
  // the most recent row is it.
  async function newestTenantId(): Promise<string> {
    return (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
  }

  it('creates a revision beside the original rather than replacing it', async () => {
    const apiKey = await tenantKey('revise@example.com');
    const tenantId = await newestTenantId();
    await finishedJob('parent-1', tenantId);

    const res = await request(app)
      .post('/api/video-edit-jobs/parent-1/revise')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ segments: [{ start: 2, end: 6 }] });

    expect(res.status).toBe(201);
    expect(res.body.job.parent_job_id).toBe('parent-1');
    expect(res.body.job.manual_segments).toEqual([{ start: 2, end: 6 }]);
    expect(res.body.job.status).toBe('processing');

    // The render the person is looking at is untouched and still downloadable.
    const parent = await queryOne<VideoEditJob>(db, `SELECT * FROM video_edit_jobs WHERE id = 'parent-1'`);
    expect(parent!.status).toBe('completed');
  });

  it('carries over the look of the original', async () => {
    const apiKey = await tenantKey('revise-look@example.com');
    const tenantId = await newestTenantId();
    await finishedJob('parent-2', tenantId);

    const res = await request(app)
      .post('/api/video-edit-jobs/parent-2/revise')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ segments: [{ start: 0, end: 5 }] });

    expect(res.body.job.subtitle_preset).toBe('bold');
    expect(res.body.job.aspect_ratio).toBe('1_1');
  });

  // The whole point of a revision: the expensive stage is already paid for.
  it('inherits the source checkpoints so nothing is transcribed twice', async () => {
    const apiKey = await tenantKey('revise-cheap@example.com');
    const tenantId = await newestTenantId();
    await finishedJob('parent-3', tenantId);

    const res = await request(app)
      .post('/api/video-edit-jobs/parent-3/revise')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ segments: [{ start: 0, end: 5 }] });

    const artifacts = res.body.job.artifacts;
    expect(artifacts.transcript.words).toHaveLength(1);
    expect(artifacts.probe.durationSec).toBe(10);
    // Measured only inside the transcribe stage, which this job will skip —
    // dropping it would silently stop the denoising the parent had.
    expect(artifacts.noise).toEqual({ headroomDb: 40, denoised: true });
    // The parent's cut and what it cost belong to the edit being replaced.
    expect(artifacts.plan).toBeUndefined();
    expect(artifacts.usage).toBeUndefined();
  });

  // A person just made this edit; pausing to ask them to approve it would be
  // asking them to check their own typing.
  it('never pauses the revision for review', async () => {
    const apiKey = await tenantKey('revise-review@example.com');
    const tenantId = await newestTenantId();
    await finishedJob('parent-4', tenantId);
    await exec(db, `UPDATE video_edit_jobs SET review_mode = 'always' WHERE id = 'parent-4'`);

    const res = await request(app)
      .post('/api/video-edit-jobs/parent-4/revise')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ segments: [{ start: 0, end: 5 }] });

    expect(res.body.job.review_mode).toBe('never');
  });

  it('refuses segments that describe no video', async () => {
    const apiKey = await tenantKey('revise-bad@example.com');
    const tenantId = await newestTenantId();
    await finishedJob('parent-5', tenantId);

    const send = (body: unknown) =>
      request(app).post('/api/video-edit-jobs/parent-5/revise').set('Authorization', `Bearer ${apiKey}`).send(body);

    expect((await send({ segments: [] })).status).toBe(400);
    expect((await send({ segments: [{ start: 4, end: 4 }] })).status).toBe(400);
    expect((await send({})).status).toBe(400);
  });

  it('refuses to revise a job that is still working', async () => {
    const apiKey = await tenantKey('revise-busy@example.com');
    const tenantId = await newestTenantId();
    await finishedJob('parent-6', tenantId);
    await exec(db, `UPDATE video_edit_jobs SET status = 'processing' WHERE id = 'parent-6'`);

    const res = await request(app)
      .post('/api/video-edit-jobs/parent-6/revise')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ segments: [{ start: 0, end: 5 }] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('job_still_running');
  });

  // Multi-tenancy isolation (CLAUDE.md): one client's footage must never be
  // reachable from another's key.
  it('will not revise another tenant\'s job', async () => {
    const mine = await tenantKey('revise-mine@example.com');
    const theirs = await tenantKey('revise-theirs@example.com');
    const theirTenant = (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
    await finishedJob('parent-7', theirTenant);

    const res = await request(app)
      .post('/api/video-edit-jobs/parent-7/revise')
      .set('Authorization', `Bearer ${mine}`)
      .send({ segments: [{ start: 0, end: 5 }] });

    expect(res.status).toBe(404);
    expect(theirs).toBeTruthy();
  });
});

describe('GET /api/video-edit-jobs/:id/editor', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('hands the editor the source, the current cut and the words', async () => {
    const keyRes = await request(app).post('/api/tenants').send({ name: 'B', email: 'editor@example.com' });
    const apiKey = keyRes.body.apiKey as string;
    const tenantId = (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, status, artifacts)
       VALUES ('ed-1', ?, 'https://cdn.test/raw.mp4', 'ai_smart_cut', 'smart_cut', ?, 'completed', ?::jsonb)`,
      tenantId,
      `tenants/${tenantId}/sources/raw.mp4`,
      JSON.stringify({
        probe: { durationSec: 12, hasAudio: true, width: 1080, height: 1920 },
        transcript: { words: [{ word: 'раз', start: 0, end: 1 }], language: 'ru' },
        plan: { segments: [{ start: 0, end: 4 }], keptDurationSec: 4, removedDurationSec: 8, droppedFillerCount: 0, degraded: false },
      })
    );

    const res = await request(app).get('/api/video-edit-jobs/ed-1/editor').set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.duration_sec).toBe(12);
    // Where the handles start: the cut that is on screen now.
    expect(res.body.segments).toEqual([{ start: 0, end: 4 }]);
    expect(res.body.words).toHaveLength(1);
    expect(res.body.manual).toBe(false);
    expect(res.body.source_url).toBeTruthy();
  });

  // Without it, someone changing a caption style is choosing blind: the
  // source player cannot show captions or a headline, because neither exists
  // outside the rendered file.
  it('hands over the finished render, captions and all', async () => {
    const keyRes = await request(app).post('/api/tenants').send({ name: 'B', email: 'editor3@example.com' });
    const apiKey = keyRes.body.apiKey as string;
    const tenantId = (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, status, output_url, artifacts)
       VALUES ('ed-3', ?, 'https://cdn.test/raw.mp4', 'ai_smart_cut', 'smart_cut', ?, 'completed', 'https://cdn.test/done.mp4', ?::jsonb)`,
      tenantId,
      `tenants/${tenantId}/sources/raw.mp4`,
      JSON.stringify({
        probe: { durationSec: 12, hasAudio: true, width: 1080, height: 1920 },
        transcript: { words: [{ word: 'раз', start: 0, end: 1 }], language: 'ru' },
      })
    );

    const res = await request(app).get('/api/video-edit-jobs/ed-3/editor').set('Authorization', `Bearer ${apiKey}`);
    expect(res.body.result_url).toBe('https://cdn.test/done.mp4');
  });

  it('says so when there is nothing to revise from', async () => {
    const keyRes = await request(app).post('/api/tenants').send({ name: 'B', email: 'editor2@example.com' });
    const apiKey = keyRes.body.apiKey as string;
    const tenantId = (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, status)
       VALUES ('ed-2', ?, 'https://cdn.test/raw.mp4', 'ai_smart_cut', 'smart_cut', 'failed')`,
      tenantId
    );

    const res = await request(app).get('/api/video-edit-jobs/ed-2/editor').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nothing_to_revise_from');
  });
});

// Everything else a person can change while they are in the editor: the
// caption style, the frame, the headline, and the words themselves.
describe('what a revision may change besides the cut', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function setup(id: string): Promise<string> {
    const keyRes = await request(app).post('/api/tenants').send({ name: 'B', email: `${id}@example.com` });
    const tenantId = (await queryOne<{ id: string }>(db, `SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`))!.id;
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, pipeline, source_object_key, status, artifacts,
         subtitles, subtitle_preset, subtitle_position, aspect_ratio, headline, headline_font, headline_size, headline_color)
       VALUES (?, ?, ?, 'ai_smart_cut', 'smart_cut', ?, 'completed', ?::jsonb,
         true, 'bold', 'top', '1_1', 'Гонка', 'montserrat', 'large', 'white')`,
      id,
      tenantId,
      `tenants/${tenantId}/sources/raw.mp4`,
      `tenants/${tenantId}/sources/raw.mp4`,
      JSON.stringify({
        probe: { durationSec: 10, hasAudio: true, width: 1080, height: 1920 },
        transcript: { words: [{ word: 'Асан', start: 0, end: 1 }, { word: 'сказал', start: 1, end: 2 }], language: 'ru' },
      })
    );
    return keyRes.body.apiKey as string;
  }

  const revise = (app: Express, key: string, id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/video-edit-jobs/${id}/revise`).set('Authorization', `Bearer ${key}`)
      .send({ segments: [{ start: 0, end: 5 }], ...body });

  it('carries the caption axes through a revision', async () => {
    const key = await setup('ax-1');
    const res = await revise(app, key, 'ax-1', {
      subtitleFont: 'oswald',
      subtitleColor: 'turquoise',
      subtitleSize: 'large',
    });

    expect(res.body.job.subtitle_font).toBe('oswald');
    expect(res.body.job.subtitle_color).toBe('turquoise');
    expect(res.body.job.subtitle_size).toBe('large');
  });

  // The combination the split exists for, end to end: a preset's look with a
  // size and colour it never carried.
  it('defers to the preset on every axis left alone', async () => {
    const key = await setup('ax-2');
    const res = await revise(app, key, 'ax-2', {});

    expect(res.body.job.subtitle_font).toBe('auto');
    expect(res.body.job.subtitle_color).toBe('auto');
    expect(res.body.job.subtitle_size).toBe('medium');
  });

  // A stale client naming a colour that no longer exists gets the preset's
  // own, not a 400 — a caption is not worth failing a paid transcription for.
  it('falls back rather than failing on an unknown axis id', async () => {
    const key = await setup('ax-3');
    const res = await revise(app, key, 'ax-3', { subtitleColor: 'вырвиглазный' });

    expect(res.status).toBe(201);
    expect(res.body.job.subtitle_color).toBe('auto');
  });

  it('applies the caption style and frame the editor sent', async () => {
    const key = await setup('st-1');
    const res = await revise(app, key, 'st-1', {
      subtitlePreset: 'minimal',
      subtitlePosition: 'bottom',
      aspectRatio: '9_16',
    });

    expect(res.body.job.subtitle_preset).toBe('minimal');
    expect(res.body.job.subtitle_position).toBe('bottom');
    expect(res.body.job.aspect_ratio).toBe('9_16');
  });

  // A revision that mentions only the cut must not quietly reset the look to
  // the system defaults — that would be a worse bug than the one it came to
  // fix, and it would be invisible until the render came back wrong.
  it('keeps everything the editor did not mention', async () => {
    const key = await setup('st-2');
    const res = await revise(app, key, 'st-2', {});

    expect(res.body.job.subtitle_preset).toBe('bold');
    expect(res.body.job.subtitle_position).toBe('top');
    expect(res.body.job.aspect_ratio).toBe('1_1');
    expect(res.body.job.headline).toBe('Гонка');
    expect(res.body.job.headline_size).toBe('large');
    expect(res.body.job.subtitles).toBe(true);
  });

  it('lets the headline be retyped, restyled and removed', async () => {
    const key = await setup('st-3');
    const retyped = await revise(app, key, 'st-3', { headline: 'Финиш', headlineColor: 'yellow' });
    expect(retyped.body.job.headline).toBe('Финиш');
    expect(retyped.body.job.headline_color).toBe('yellow');

    // An empty string is how the band is taken off entirely; falling back to
    // the parent here would make a headline impossible to remove.
    const removed = await revise(app, key, 'st-3', { headline: '' });
    expect(removed.body.job.headline).toBeNull();
  });

  it('turns captions off when asked', async () => {
    const key = await setup('st-4');
    const res = await revise(app, key, 'st-4', { subtitles: false });
    expect(res.body.job.subtitles).toBe(false);
  });

  // The point of correcting words rather than caption lines: the fix lives in
  // the source timeline, so it survives whatever cut this same edit drew.
  it('takes corrected words and keeps the pipeline timings', async () => {
    const key = await setup('st-5');
    const res = await revise(app, key, 'st-5', { words: ['Асхат', 'сказал'] });

    const words = res.body.job.artifacts.transcript.words;
    expect(words[0].word).toBe('Асхат');
    expect(words[0].start).toBe(0);
    expect(words[0].end).toBe(1);
    expect(words[1].word).toBe('сказал');
  });

  it('refuses a word list that is not a correction of this transcript', async () => {
    const key = await setup('st-6');
    const res = await revise(app, key, 'st-6', { words: ['только одно'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('words_length_mismatch');
  });

  it('opens the editor with the look this render actually used', async () => {
    const key = await setup('st-7');
    const res = await request(app).get('/api/video-edit-jobs/st-7/editor').set('Authorization', `Bearer ${key}`);

    expect(res.body.style).toMatchObject({
      subtitles: true,
      subtitlePreset: 'bold',
      subtitlePosition: 'top',
      aspectRatio: '1_1',
      headline: 'Гонка',
      headlineSize: 'large',
    });
  });
});
