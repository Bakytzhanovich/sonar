import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { mockPublish, publishDuePosts } from '../src/publisher';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'posts@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string };
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
      .send({ platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(res.body.post.status).toBe('scheduled');
    expect(res.body.post.requires_approval).toBe(false);
  });

  it('rejects an unknown platform', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ platform: 'facebook', caption: 'x', scheduledAt: '2026-09-01T10:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('a post created with requiresApproval sits in pending_approval until approved', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z', requiresApproval: true });
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
      .send({ platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z' });

    const res = await request(app).post(`/api/scheduled-posts/${created.body.post.id}/approve`).set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(422);
  });

  it('reject sets status to rejected and blocks it from ever publishing', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ platform: 'instagram', caption: 'Привет', scheduledAt: '2020-01-01T00:00:00.000Z', requiresApproval: true });

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
      .send({ platform: 'instagram', caption: 'Привет', scheduledAt: '2026-09-01T10:00:00.000Z', requiresApproval: true });
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
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status) VALUES (?, 't1', 'instagram', 'x', ?, 'scheduled')`,
      'due-1',
      '2026-01-01T00:00:00.000Z'
    );
    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status) VALUES (?, 't1', 'instagram', 'x', ?, 'scheduled')`,
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
      .send({ platform: 'instagram', caption: 'A', scheduledAt: '2026-01-01T00:00:00.000Z' });
    await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ platform: 'tiktok', caption: 'B', scheduledAt: '2026-06-01T00:00:00.000Z' });

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
      .send({ platform: 'instagram', caption: 'x', scheduledAt: '2026-01-01T00:00:00.000Z', requiresApproval: true });

    const read = await request(app).get(`/api/scheduled-posts/${created.body.post.id}`).set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(read.status).toBe(404);

    const approve = await request(app)
      .post(`/api/scheduled-posts/${created.body.post.id}/approve`)
      .set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(approve.status).toBe(404);
  });
});
