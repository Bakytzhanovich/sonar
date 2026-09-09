import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { advanceRenderJobs } from '../src/videoRender';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'video@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string };
}

describe('video edit job API', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('creates a job at 0% progress, processing', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceVideoUrl: 'https://example.com/video.mp4', template: 'auto_crop_916' });

    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ status: 'processing', progress_percent: 0 });
  });

  it('rejects an unknown template', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceVideoUrl: 'https://example.com/video.mp4', template: 'level_3_ai_engine' });
    expect(res.status).toBe(400);
  });

  it('advances progress across ticks and eventually resolves to completed or failed, never silently stuck', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceVideoUrl: 'https://example.com/video.mp4', template: 'auto_crop_916' });
    const jobId = created.body.job.id;

    let last = created.body.job;
    for (let tick = 0; tick < 5 && last.status === 'processing'; tick++) {
      await request(app).post('/api/video-edit-jobs/process-tick').set('Authorization', `Bearer ${apiKey}`);
      const fetched = await request(app).get(`/api/video-edit-jobs/${jobId}`).set('Authorization', `Bearer ${apiKey}`);
      last = fetched.body.job;
    }

    expect(['completed', 'failed']).toContain(last.status);
    expect(last.progress_percent).toBe(100);
  });

  it('one tenant cannot see another tenant\'s render job', async () => {
    const owner = await createTenant(app, 'owner-video@example.com');
    const intruder = await createTenant(app, 'intruder-video@example.com');
    const created = await request(app)
      .post('/api/video-edit-jobs')
      .set('Authorization', `Bearer ${owner.apiKey}`)
      .send({ sourceVideoUrl: 'https://example.com/video.mp4', template: 'auto_crop_916' });

    const read = await request(app).get(`/api/video-edit-jobs/${created.body.job.id}`).set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(read.status).toBe(404);
  });
});

describe('advanceRenderJobs (pure)', () => {
  let db: Db;

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('increments progress by 25 per tick and leaves non-processing jobs untouched', async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, status, progress_percent) VALUES ('j1', 't1', 'url', 'auto_crop_916', 'processing', 0)`
    );
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, status, progress_percent) VALUES ('j2', 't1', 'url', 'auto_crop_916', 'completed', 100)`
    );

    await advanceRenderJobs(db);

    const j1 = await queryOne<{ progress_percent: number; status: string }>(db, `SELECT progress_percent, status FROM video_edit_jobs WHERE id = 'j1'`);
    const j2 = await queryOne<{ progress_percent: number }>(db, `SELECT progress_percent FROM video_edit_jobs WHERE id = 'j2'`);

    expect(j1!.progress_percent).toBe(25);
    expect(j1!.status).toBe('processing');
    expect(j2!.progress_percent).toBe(100); // untouched
  });
});
