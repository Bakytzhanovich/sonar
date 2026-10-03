import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { mockPublish, publishDuePosts } from '../src/publisher';
import { createTestDb, dropTestDb } from './dbTestHelper';

// Posts carry a video now; any key under the tenant's own uploads will do.
const videoFor = new Map<string, string>();
async function createTenant(app: Express, email = 'posts@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  videoFor.set(res.body.apiKey, `tenants/${res.body.tenant.id}/sources/clip.mp4`);
  return { apiKey: res.body.apiKey as string, tenantId: res.body.tenant.id as string };
}

describe('mockPublish (pure)', () => {
  it('is deterministic per post id', () => {
    const a = mockPublish('post-1', 'instagram');
    const b = mockPublish('post-1', 'instagram');
    expect(a).toEqual(b);
  });

  it('exercises both the success and failure path across many ids', () => {
    const outcomes = Array.from({ length: 100 }, (_, i) => mockPublish(`post-${i}`, 'tiktok'));
    expect(outcomes.some((o) => o.success)).toBe(true);
    expect(outcomes.some((o) => !o.success)).toBe(true);
  });
});

describe('scheduled posts API + publishDuePosts', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('creates a post without approval as immediately scheduled', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(res.body.post.status).toBe('scheduled');
    expect(res.body.post.requires_approval).toBe(false);
  });

  it('rejects an unknown platform', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'facebook', caption: 'x', scheduledAt: '2026-09-01T10:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('a post created with requiresApproval sits in pending_approval until approved', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z', requiresApproval: true });
    expect(created.body.post.status).toBe('pending_approval');

    const approved = await request(app)
      .post(`/api/scheduled-posts/${created.body.post.id}/approve`)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(approved.body.post.status).toBe('scheduled');
  });

  it('rejects approving a post that is not pending approval', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z' });

    const res = await request(app).post(`/api/scheduled-posts/${created.body.post.id}/approve`).set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(422);
  });

  it('reject sets status to rejected and blocks it from ever publishing', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'instagram', caption: 'Привет', scheduledAt: '2020-01-01T00:00:00.000Z', requiresApproval: true });

    await request(app).post(`/api/scheduled-posts/${created.body.post.id}/reject`).set('Authorization', `Bearer ${apiKey}`);

    const processed = await request(app).post('/api/scheduled-posts/process-due').set('Authorization', `Bearer ${apiKey}`);
    expect(processed.body.processed).toBe(0);

    const fetched = await request(app).get(`/api/scheduled-posts/${created.body.post.id}`).set('Authorization', `Bearer ${apiKey}`);
    expect(fetched.body.post.status).toBe('rejected');
  });

  it('under true concurrency, many simultaneous approve/reject calls on the same post let exactly one through', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z', requiresApproval: true });
    const id = created.body.post.id;

    // A plain 2-way Promise.all (one approve + one reject) turned out not
    // to reliably race this endpoint: its guard SELECT is fast enough that
    // in practice the winner's SELECT+UPDATE usually both complete before
    // the loser's own guard SELECT even runs — confirmed empirically, 3/3
    // runs at 10-way concurrency here. That means the loser sees the
    // already-flipped status at its OWN precondition check and gets 422
    // ("not pending approval") rather than 409 (losing the UPDATE's WHERE
    // clause) — both are correct, race-safe outcomes; what would be a bug
    // is two 200s or a bare 500. 5 approves + 5 rejects fired together
    // gives enough concurrent attempts to make the invariant meaningful to
    // check, regardless of which of the two valid loser-paths each one hits.
    const calls = [
      ...Array.from({ length: 5 }, () => request(app).post(`/api/scheduled-posts/${id}/approve`).set('Authorization', `Bearer ${apiKey}`)),
      ...Array.from({ length: 5 }, () => request(app).post(`/api/scheduled-posts/${id}/reject`).set('Authorization', `Bearer ${apiKey}`)),
    ];
    const results = await Promise.all(calls);

    const successes = results.filter((r) => r.status === 200);
    expect(successes).toHaveLength(1); // mutual exclusion: exactly one caller wins, ever
    expect(results.every((r) => r.status === 200 || r.status === 409 || r.status === 422)).toBe(true); // never a bare 500

    const fetched = await request(app).get(`/api/scheduled-posts/${id}`).set('Authorization', `Bearer ${apiKey}`);
    expect(['scheduled', 'rejected']).toContain(fetched.body.post.status);
  });

  it('publishDuePosts only touches scheduled posts whose time has come, leaving future ones alone', async () => {
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);

    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status, video_object_key) VALUES (?, 't1', 'instagram', 'x', ?, 'scheduled', 'tenants/t1/sources/clip.mp4')`,
      'due-1',
      '2026-01-01T00:00:00.000Z'
    );
    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status, video_object_key) VALUES (?, 't1', 'instagram', 'x', ?, 'scheduled', 'tenants/t1/sources/clip.mp4')`,
      'future-1',
      '2099-01-01T00:00:00.000Z'
    );

    const result = await publishDuePosts(db, new Date('2026-06-01T00:00:00.000Z'));
    expect(result.processed).toBe(1);

    const due = await queryOne<{ status: string }>(db, `SELECT status FROM scheduled_posts WHERE id = 'due-1'`);
    const future = await queryOne<{ status: string }>(db, `SELECT status FROM scheduled_posts WHERE id = 'future-1'`);
    expect(due!.status).not.toBe('scheduled');
    expect(future!.status).toBe('scheduled');
  });

  it('filters the list by status and date range', async () => {
    const { apiKey } = await createTenant(app);
    await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'instagram', caption: 'A', scheduledAt: '2026-01-01T00:00:00.000Z' });
    await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ videoObjectKey: videoFor.get(apiKey), platform: 'tiktok', caption: 'B', scheduledAt: '2026-06-01T00:00:00.000Z' });

    const janOnly = await request(app)
      .get('/api/scheduled-posts?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(janOnly.body.posts).toHaveLength(1);
    expect(janOnly.body.posts[0].caption).toBe('A');
  });

  it('one tenant cannot see or approve another tenant\'s post', async () => {
    const owner = await createTenant(app, 'owner-posts@example.com');
    const intruder = await createTenant(app, 'intruder-posts@example.com');
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${owner.apiKey}`)
      .send({ videoObjectKey: videoFor.get(owner.apiKey), platform: 'instagram', caption: 'x', scheduledAt: '2026-01-01T00:00:00.000Z', requiresApproval: true });

    const read = await request(app).get(`/api/scheduled-posts/${created.body.post.id}`).set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(read.status).toBe(404);

    const approve = await request(app)
      .post(`/api/scheduled-posts/${created.body.post.id}/approve`)
      .set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(approve.status).toBe(404);
  });
  describe('the video a post carries', () => {
    const when = '2026-09-01T10:00:00.000Z';
    async function render(tenantId: string, id: string, fields: { status?: string; previewOf?: string | null } = {}) {
      await exec(
        db,
        `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, status, output_object_key, preview_of)
         VALUES (?, ?, 'upload', 'ai_smart_cut', ?, ?, ?)`,
        id,
        tenantId,
        fields.status ?? 'completed',
        `tenants/${tenantId}/renders/${id}.mp4`,
        fields.previewOf ?? null
      );
    }

    it('refuses a post with nothing to publish', async () => {
      const { apiKey } = await createTenant(app);
      const res = await request(app)
        .post('/api/scheduled-posts')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ platform: 'instagram', caption: 'Привет', scheduledAt: when });
      expect(res.status).toBe(400);
    });

    it('refuses another account\'s upload', async () => {
      const { apiKey } = await createTenant(app);
      const res = await request(app)
        .post('/api/scheduled-posts')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ platform: 'instagram', caption: 'Привет', scheduledAt: when, videoObjectKey: 'tenants/someone-else/sources/clip.mp4' });
      expect(res.status).toBe(403);
    });

    it('takes a finished render from the editor, and keeps the storage key to itself', async () => {
      const { apiKey, tenantId } = await createTenant(app);
      await render(tenantId, 'job-done');
      const res = await request(app)
        .post('/api/scheduled-posts')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ platform: 'instagram', caption: 'Привет', scheduledAt: when, videoJobId: 'job-done' });

      expect(res.status).toBe(201);
      expect(res.body.post.video_job_id).toBe('job-done');
      expect(res.body.post).not.toHaveProperty('video_object_key');
      const row = await queryOne<{ video_object_key: string }>(db, `SELECT video_object_key FROM scheduled_posts WHERE id = ?`, res.body.post.id);
      expect(row!.video_object_key).toBe(`tenants/${tenantId}/renders/job-done.mp4`);
    });

    it('will not schedule a render that is unfinished, a preview, or someone else\'s', async () => {
      const { apiKey, tenantId } = await createTenant(app);
      const other = await createTenant(app, 'other-posts@example.com');
      await render(tenantId, 'job-busy', { status: 'processing' });
      await render(tenantId, 'job-done');
      await render(tenantId, 'job-preview', { previewOf: 'job-done' });
      await render(other.tenantId, 'job-theirs');

      const post = (videoJobId: string) =>
        request(app)
          .post('/api/scheduled-posts')
          .set('Authorization', `Bearer ${apiKey}`)
          .send({ platform: 'instagram', caption: 'Привет', scheduledAt: when, videoJobId });
      expect((await post('job-busy')).status).toBe(409);
      expect((await post('job-preview')).status).toBe(409);
      expect((await post('job-theirs')).status).toBe(404);
    });

    // Rows from before posts carried a video. "Publishing" one would report
    // a reel that does not exist as live.
    it('fails an old post that has no video instead of pretending to publish it', async () => {
      await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t-old', 'T', 'old@example.com')`);
      await exec(
        db,
        `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status) VALUES ('old-post', 't-old', 'instagram', 'x', '2026-01-01T00:00:00.000Z', 'scheduled')`
      );
      await publishDuePosts(db, new Date('2026-06-01T00:00:00.000Z'));
      const row = await queryOne<{ status: string; failure_reason: string }>(db, `SELECT status, failure_reason FROM scheduled_posts WHERE id = 'old-post'`);
      expect(row).toEqual({ status: 'failed', failure_reason: 'no_video' });
    });
  });
});
