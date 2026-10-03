import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { saveConnectedAccount } from '../src/platformAccounts';
import { keyringFrom } from '../src/tokenVault';
import { createTestDb, dropTestDb } from './dbTestHelper';

const ring = keyringFrom([['v1', randomBytes(32)]]);
const LATER = '2026-12-01T10:00:00.000Z';

describe('changing a scheduled post', () => {
  let db: Db;
  let app: Express;
  let auth: string;
  let tenantId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db, { tokenKeyring: ring, instagram: null });
    const res = await request(app).post('/api/tenants').send({ name: 'B', email: 'b@example.com' });
    auth = `Bearer ${res.body.apiKey}`;
    tenantId = res.body.tenant.id;
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function schedule(fields: Record<string, unknown> = {}) {
    const res = await request(app)
      .post('/api/scheduled-posts')
      .set('Authorization', auth)
      .send({ platform: 'instagram', caption: 'Было', scheduledAt: LATER, videoObjectKey: `tenants/${tenantId}/sources/v.mp4`, ...fields });
    return res.body.post.id as string;
  }
  const set = (id: string, sql: string, ...params: unknown[]) => exec(db, `UPDATE scheduled_posts SET ${sql} WHERE id = ?`, ...params, id);
  const row = (id: string) => queryOne<Record<string, unknown>>(db, `SELECT * FROM scheduled_posts WHERE id = ?`, id);

  it('cancels a post that has not gone out yet', async () => {
    const id = await schedule();
    expect((await request(app).delete(`/api/scheduled-posts/${id}`).set('Authorization', auth)).status).toBe(204);
    expect(await row(id)).toBeUndefined();
  });

  // The rule the whole feature rests on.
  it('will not cancel or edit a post already handed to Instagram, or one being worked on', async () => {
    const handed = await schedule();
    await set(handed, `status = 'publishing', ig_container_id = 'c1', publish_stage = 'container'`);
    const claimed = await schedule();
    await set(claimed, `status = 'publishing', claimed_at = now()`);
    const published = await schedule();
    await set(published, `status = 'published'`);

    for (const id of [handed, claimed]) {
      const del = await request(app).delete(`/api/scheduled-posts/${id}`).set('Authorization', auth);
      expect(del.status).toBe(409);
      expect(del.body.error).toBe('already_publishing');
      expect((await request(app).patch(`/api/scheduled-posts/${id}`).set('Authorization', auth).send({ caption: 'x' })).status).toBe(409);
    }
    expect((await request(app).delete(`/api/scheduled-posts/${published}`).set('Authorization', auth)).body.error).toBe('already_published');
    expect(await row(handed)).toBeDefined();
  });

  it('cancels a post that is only waiting its turn, before anything reached Instagram', async () => {
    const id = await schedule();
    await set(id, `status = 'publishing', waiting_reason = 'pace', next_attempt_at = now()`);
    expect((await request(app).delete(`/api/scheduled-posts/${id}`).set('Authorization', auth)).status).toBe(204);
  });

  it('edits the caption and the time, and puts a waiting post back on the schedule', async () => {
    const id = await schedule();
    await set(id, `status = 'publishing', waiting_reason = 'instagram_limit', next_attempt_at = now()`);
    const res = await request(app)
      .patch(`/api/scheduled-posts/${id}`)
      .set('Authorization', auth)
      .send({ caption: '  Стало  ', scheduledAt: '2026-12-02T08:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.post).toMatchObject({ caption: 'Стало', status: 'scheduled', waiting_reason: null });
    expect(new Date(res.body.post.scheduled_at).toISOString()).toBe('2026-12-02T08:00:00.000Z');
  });

  it('refuses an edit with an empty caption or another workspace\'s account', async () => {
    const id = await schedule();
    expect((await request(app).patch(`/api/scheduled-posts/${id}`).set('Authorization', auth).send({ caption: ' ' })).status).toBe(400);
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('other', 'O', 'o@example.com')`);
    const theirs = await saveConnectedAccount(db, ring, 'other', 'instagram', { userId: '9', username: 'o', accessToken: 't', expiresAt: new Date(Date.now() + 9e9) });
    expect((await request(app).patch(`/api/scheduled-posts/${id}`).set('Authorization', auth).send({ platformAccountId: theirs.id })).status).toBe(404);
  });

  it('runs a failed post again, from the start', async () => {
    const id = await schedule();
    await set(id, `status = 'failed', failure_reason = 'processing_failed', ig_container_id = 'c1', publish_stage = 'container', attempts = 3`);
    const res = await request(app).post(`/api/scheduled-posts/${id}/retry`).set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'scheduled', failure_reason: null, ig_container_id: null, publish_stage: null, attempts: 0 });
    // As soon as the publisher next runs, not at the original time.
    expect(new Date((await row(id))!.scheduled_at as string).getTime()).toBeLessThanOrEqual(Date.now());
  });

  // A post that failed at the publish call may be live already. Starting it
  // over would make a second container and publish it twice.
  it('resumes a post that failed at the publish call, so Instagram is asked before anything is published', async () => {
    const id = await schedule();
    await set(id, `status = 'failed', failure_reason = 'publish_failed', ig_container_id = 'c1', publish_stage = 'publishing'`);
    await request(app).post(`/api/scheduled-posts/${id}/retry`).set('Authorization', auth);
    expect(await row(id)).toMatchObject({ status: 'publishing', ig_container_id: 'c1', publish_stage: 'publishing', claimed_at: null });
  });

  it('will not retry what retrying cannot fix', async () => {
    const id = await schedule();
    expect((await request(app).post(`/api/scheduled-posts/${id}/retry`).set('Authorization', auth)).body.error).toBe('not_failed');

    const account = await saveConnectedAccount(db, ring, tenantId, 'instagram', { userId: '1', username: 'me', accessToken: 't', expiresAt: new Date(Date.now() + 9e9) });
    const dead = await schedule({ platformAccountId: account.id });
    await set(dead, `status = 'failed', failure_reason = 'token_expired'`);
    await exec(db, `UPDATE platform_accounts SET status = 'needs_reconnect'`);
    expect((await request(app).post(`/api/scheduled-posts/${dead}/retry`).set('Authorization', auth)).body.error).toBe('account_needs_reconnect');

    await exec(db, `DELETE FROM platform_accounts`);
    expect((await request(app).post(`/api/scheduled-posts/${dead}/retry`).set('Authorization', auth)).body.error).toBe('account_unavailable');
  });

  it('keeps another workspace out of all three', async () => {
    const id = await schedule();
    const other = await request(app).post('/api/tenants').send({ name: 'X', email: 'x@example.com' });
    const theirAuth = `Bearer ${other.body.apiKey}`;
    expect((await request(app).delete(`/api/scheduled-posts/${id}`).set('Authorization', theirAuth)).status).toBe(404);
    expect((await request(app).patch(`/api/scheduled-posts/${id}`).set('Authorization', theirAuth).send({ caption: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/scheduled-posts/${id}/retry`).set('Authorization', theirAuth)).status).toBe(404);
    expect(await row(id)).toMatchObject({ caption: 'Было' });
  });
});
