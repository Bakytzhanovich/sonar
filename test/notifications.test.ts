import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, type Db } from '../src/db';
import { createApp } from '../src/api';
import { notify, listNotifications } from '../src/notifications';
import { publishDuePosts } from '../src/publisher';
import { advanceRenderJobs } from '../src/videoRender';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'push@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string, tenantId: res.body.tenant.id as string };
}

describe('notify / listNotifications (pure)', () => {
  let db: Db;

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('writes an in-app notification row even with no push subscriptions (the required fallback)', async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);

    await notify(db, 't1', 'post_published', 'Тестовое сообщение', 'related-1');

    const notifications = await listNotifications(db, 't1', false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: 'post_published', message: 'Тестовое сообщение', related_id: 'related-1', is_read: false });
  });

  it('unreadOnly filters out read notifications', async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);
    await notify(db, 't1', 'post_published', 'A');
    await notify(db, 't1', 'post_failed', 'B');

    const all = await listNotifications(db, 't1', false);
    await exec(db, `UPDATE notifications SET is_read = true WHERE id = ?`, all[0].id);

    expect(await listNotifications(db, 't1', true)).toHaveLength(1);
    expect(await listNotifications(db, 't1', false)).toHaveLength(2);
  });
});

describe('notifications fire from real publisher/render flows', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('publishDuePosts notifies whichever way the post resolves', async () => {
    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status) VALUES ('post-success', 't1', 'instagram', 'x', '2020-01-01T00:00:00.000Z', 'scheduled')`
    );

    await publishDuePosts(db, new Date('2026-01-01T00:00:00.000Z'));

    const notifications = await listNotifications(db, 't1', false);
    expect(notifications).toHaveLength(1);
    expect(['post_published', 'post_failed']).toContain(notifications[0].type);
  });

  it('advanceRenderJobs notifies once a job resolves, not on intermediate progress ticks', async () => {
    await exec(
      db,
      `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, status, progress_percent) VALUES ('job-1', 't1', 'url', 'auto_crop_916', 'processing', 0)`
    );

    await advanceRenderJobs(db); // 0 -> 25%, not resolved yet
    expect(await listNotifications(db, 't1', false)).toHaveLength(0);

    await advanceRenderJobs(db); // 25 -> 50
    await advanceRenderJobs(db); // 50 -> 75
    await advanceRenderJobs(db); // 75 -> 100, resolves
    const notifications = await listNotifications(db, 't1', false);
    expect(notifications).toHaveLength(1);
    expect(['video_completed', 'video_failed']).toContain(notifications[0].type);
  });
});

describe('push + notifications API', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('returns a VAPID public key', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app).get('/api/push/vapid-public-key').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(0);
  });

  it('subscribes and unsubscribes a push endpoint', async () => {
    const { apiKey } = await createTenant(app);
    const sub = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p256dh-value', auth: 'auth-value' } });
    expect(sub.status).toBe(201);

    const unsub = await request(app)
      .post('/api/push/unsubscribe')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ endpoint: 'https://push.example.com/abc' });
    expect(unsub.status).toBe(200);
  });

  it('creating a post that requires approval produces a pending_approval notification', async () => {
    const { apiKey } = await createTenant(app);
    await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ platform: 'instagram', caption: 'x', scheduledAt: '2026-01-01T00:00:00.000Z', requiresApproval: true });

    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${apiKey}`);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].type).toBe('post_pending_approval');
  });

  it('marks a notification as read', async () => {
    const { apiKey } = await createTenant(app);
    await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ platform: 'instagram', caption: 'x', scheduledAt: '2026-01-01T00:00:00.000Z', requiresApproval: true });
    const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${apiKey}`);
    const notificationId = list.body.notifications[0].id;

    await request(app).post(`/api/notifications/${notificationId}/read`).set('Authorization', `Bearer ${apiKey}`);

    const unread = await request(app).get('/api/notifications?unreadOnly=true').set('Authorization', `Bearer ${apiKey}`);
    expect(unread.body.notifications).toHaveLength(0);
  });

  it('one tenant cannot see another tenant\'s notifications', async () => {
    const owner = await createTenant(app, 'owner-push@example.com');
    const intruder = await createTenant(app, 'intruder-push@example.com');
    await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', `Bearer ${owner.apiKey}`)
      .send({ platform: 'instagram', caption: 'x', scheduledAt: '2026-01-01T00:00:00.000Z', requiresApproval: true });

    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(res.body.notifications).toHaveLength(0);
  });
});
