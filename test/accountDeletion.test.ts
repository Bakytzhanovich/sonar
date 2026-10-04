import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryAll, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { eraseAccount, purgeTranscriptCache } from '../src/accountDeletion';
import { requiredRole } from '../src/roles';
import { createTestDb, dropTestDb } from './dbTestHelper';

// The customer's right to erasure: their whole workspace, on request.

async function tablesWithTenant(db: Db): Promise<string[]> {
  const rows = await queryAll<{ table_name: string }>(
    db,
    `SELECT table_name FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema = current_schema()`
  );
  return rows.map((r) => r.table_name);
}

describe('erasing an account', () => {
  let db: Db;
  let app: Express;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db, { reelChat: async () => JSON.stringify({ slides: Array.from({ length: 4 }, (_, i) => ({ headline: `С${i}`, body: 'т' })) }), tokenKeyring: null, instagram: null });
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  /** A signed-in owner with something in every part of the product. */
  async function fullAccount(email: string) {
    const agent = request.agent(app);
    const signup = await agent.post('/api/auth/signup').send({ email, password: 'correct-horse-1' });
    const tenantId = signup.body.tenant.id as string;
    const demo = await agent.post('/api/onboarding/demo-workspace').send({ keyword: 'цена', replyText: 'Привет' });
    await agent.post(`/api/bots/${demo.body.bot.id}/simulate-incoming`).send({ externalUserId: 'buyer', messageText: 'цена?' });
    await agent.post('/api/carousels').send({ prompt: 'тема' });
    await agent.post('/api/brand-presets').send({ name: 'Стиль' });
    await agent.post('/api/scheduled-posts').send({ platform: 'instagram', caption: 'x', scheduledAt: new Date(Date.now() + 864e5).toISOString(), videoObjectKey: `tenants/${tenantId}/sources/a.mp4` });
    await exec(db, `INSERT INTO video_edit_jobs (id, tenant_id, source_video_url, template, status, source_object_key, output_object_key, audio_hash)
                    VALUES (?, ?, 'upload', 'ai_smart_cut', 'completed', ?, ?, ?)`,
      `job-${tenantId}`, tenantId, `tenants/${tenantId}/sources/v.mp4`, `tenants/${tenantId}/renders/job.mp4`, `hash-${tenantId}`);
    await exec(db, `INSERT INTO transcript_cache (audio_hash, words, text, language) VALUES (?, '[]'::jsonb, 'речь', 'ru')`, `hash-${tenantId}`);
    await exec(db, `INSERT INTO reel_analyses (id, tenant_id, status, source_object_key) VALUES (?, ?, 'processing', ?)`, `reel-${tenantId}`, tenantId, `tenants/${tenantId}/sources/r.mp4`);
    await exec(db, `INSERT INTO notifications (id, tenant_id, type, message) VALUES (?, ?, 'video_completed', 'готово')`, `n-${tenantId}`, tenantId);
    return { agent, tenantId };
  }

  it('removes every row the account owned, and nothing of anyone else\'s', async () => {
    const mine = await fullAccount('owner@example.com');
    const theirs = await fullAccount('neighbour@example.com');

    expect((await mine.agent.delete('/api/account').send({ password: 'wrong' })).status).toBe(403);
    const res = await mine.agent.delete('/api/account').send({ password: 'correct-horse-1' });
    expect(res.status).toBe(204);

    for (const table of await tablesWithTenant(db)) {
      const left = await queryAll(db, `SELECT 1 FROM ${table} WHERE tenant_id = ?`, mine.tenantId);
      expect(left, `${table} still holds rows`).toHaveLength(0);
    }
    expect(await queryOne(db, `SELECT id FROM tenants WHERE id = ?`, mine.tenantId)).toBeUndefined();
    expect(await queryOne(db, `SELECT 1 FROM transcript_cache WHERE audio_hash = ?`, `hash-${mine.tenantId}`)).toBeUndefined();
    expect(await queryAll(db, `SELECT 1 FROM subscribers s JOIN bots b ON b.id = s.bot_id WHERE b.tenant_id = ?`, mine.tenantId)).toHaveLength(0);

    // The neighbour is untouched.
    expect(await queryOne(db, `SELECT id FROM tenants WHERE id = ?`, theirs.tenantId)).toBeDefined();
    expect(await queryOne(db, `SELECT 1 FROM transcript_cache WHERE audio_hash = ?`, `hash-${theirs.tenantId}`)).toBeDefined();
    expect((await queryAll(db, `SELECT 1 FROM messages WHERE tenant_id = ?`, theirs.tenantId)).length).toBeGreaterThan(0);

    // And the deleted account cannot be used any more.
    expect((await mine.agent.get('/api/carousels')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'correct-horse-1' })).status).toBe(401);
  });

  it('names every file the account owned, renders\' posters included', async () => {
    const mine = await fullAccount('files@example.com');
    const { objectKeys } = await eraseAccount(db, mine.tenantId);
    const prefix = `tenants/${mine.tenantId}`;
    expect(objectKeys.sort()).toEqual([
      `${prefix}/renders/job.jpg`,
      `${prefix}/renders/job.mp4`,
      `${prefix}/sources/a.mp4`,
      `${prefix}/sources/r.mp4`,
      `${prefix}/sources/v.mp4`,
    ]);
  });

  it('is for the owner, signed in with a password — not an API key, not an editor', async () => {
    expect(requiredRole('DELETE', '/api/account')).toBe('owner');
    const t = await request(app).post('/api/tenants').send({ name: 'K', email: 'key@example.com' });
    const res = await request(app).delete('/api/account').set('Authorization', `Bearer ${t.body.apiKey}`).send({ password: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('the transcript cache', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('keeps a transcript for a month, not forever', async () => {
    const now = new Date('2026-10-04T12:00:00Z');
    await exec(db, `INSERT INTO transcript_cache (audio_hash, words, text, language, created_at) VALUES ('old', '[]'::jsonb, 'x', 'ru', ?), ('new', '[]'::jsonb, 'y', 'ru', ?)`,
      new Date(now.getTime() - 31 * 864e5).toISOString(), new Date(now.getTime() - 2 * 864e5).toISOString());
    expect(await purgeTranscriptCache(db, now)).toBe(1);
    expect((await queryAll<{ audio_hash: string }>(db, `SELECT audio_hash FROM transcript_cache`)).map((r) => r.audio_hash)).toEqual(['new']);
  });
});
