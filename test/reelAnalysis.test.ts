import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { analyzeReelMock, generateScriptMock } from '../src/reelAnalysis';
import type { ReelAnalysis } from '../src/types';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'reels@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string };
}

describe('analyzeReelMock / generateScriptMock (pure)', () => {
  it('is deterministic for the same URL', () => {
    const a = analyzeReelMock('https://instagram.com/reel/abc');
    const b = analyzeReelMock('https://instagram.com/reel/abc');
    expect(a).toEqual(b);
  });

  it('produces different output for different URLs (not just a constant)', () => {
    const a = analyzeReelMock('https://instagram.com/reel/abc');
    const b = analyzeReelMock('https://instagram.com/reel/xyz');
    expect(a).not.toEqual(b);
  });

  it('generates a script that references the analysis hook and niche', () => {
    const fields = analyzeReelMock('https://instagram.com/reel/abc');
    const analysis: ReelAnalysis = { id: 'a1', tenant_id: 't1', created_at: '2026-01-01T00:00:00.000Z', ...fields };
    const script = generateScriptMock(analysis, 'фитнес');
    expect(script).toContain(fields.hook);
    expect(script).toContain('фитнес');
  });
});

describe('reel analysis API', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('creates an analysis and lists it in the library', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceUrl: 'https://instagram.com/reel/abc' });

    expect(created.status).toBe(201);
    expect(created.body.analysis).toMatchObject({ source_url: 'https://instagram.com/reel/abc' });
    expect(Array.isArray(created.body.analysis.structure)).toBe(true);

    const list = await request(app).get('/api/reel-analyses').set('Authorization', `Bearer ${apiKey}`);
    expect(list.body.analyses).toHaveLength(1);
  });

  it('rejects an empty sourceUrl', async () => {
    const { apiKey } = await createTenant(app);
    const res = await request(app).post('/api/reel-analyses').set('Authorization', `Bearer ${apiKey}`).send({ sourceUrl: '  ' });
    expect(res.status).toBe(400);
  });

  it('generates and lists scripts for an analysis, and finds them by niche across the library', async () => {
    const { apiKey } = await createTenant(app);
    const created = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceUrl: 'https://instagram.com/reel/abc' });
    const analysisId = created.body.analysis.id;

    const script = await request(app)
      .post(`/api/reel-analyses/${analysisId}/scripts`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ niche: 'фитнес' });
    expect(script.status).toBe(201);
    expect(script.body.script.niche).toBe('фитнес');

    const forAnalysis = await request(app).get(`/api/reel-analyses/${analysisId}/scripts`).set('Authorization', `Bearer ${apiKey}`);
    expect(forAnalysis.body.scripts).toHaveLength(1);

    const byNiche = await request(app).get('/api/scripts?niche=фитнес').set('Authorization', `Bearer ${apiKey}`);
    expect(byNiche.body.scripts).toHaveLength(1);

    const wrongNiche = await request(app).get('/api/scripts?niche=кулинария').set('Authorization', `Bearer ${apiKey}`);
    expect(wrongNiche.body.scripts).toHaveLength(0);
  });

  it('one tenant cannot see or generate scripts for another tenant\'s analysis', async () => {
    const owner = await createTenant(app, 'owner-reels@example.com');
    const intruder = await createTenant(app, 'intruder-reels@example.com');
    const created = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${owner.apiKey}`)
      .send({ sourceUrl: 'https://instagram.com/reel/abc' });

    const read = await request(app).get(`/api/reel-analyses/${created.body.analysis.id}`).set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(read.status).toBe(404);

    const write = await request(app)
      .post(`/api/reel-analyses/${created.body.analysis.id}/scripts`)
      .set('Authorization', `Bearer ${intruder.apiKey}`)
      .send({ niche: 'фитнес' });
    expect(write.status).toBe(404);
  });
});
