import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, type Db } from '../src/db';
import { createApp } from '../src/api';
import { computeContentRecommendations } from '../src/contentRecommendations';
import { createTestDb, dropTestDb } from './dbTestHelper';

const TENANT_ID = 't1';
const BOT_ID = 'bot1';

async function seedTenantAndBot(db: Db) {
  await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'T', 't@example.com')`, TENANT_ID);
  await exec(db, `INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES (?, ?, 'Bot', 'ig-1')`, BOT_ID, TENANT_ID);
}

async function addTaggedSubscriber(db: Db, id: string, tagId: string, leadStatus: string) {
  await exec(db, `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, lead_status) VALUES (?, ?, ?, ?, ?)`, id, TENANT_ID, BOT_ID, id, leadStatus);
  await exec(db, `INSERT INTO subscriber_tags (subscriber_id, tag_id) VALUES (?, ?)`, id, tagId);
}

describe('computeContentRecommendations (pure logic)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await seedTenantAndBot(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('skips tags with zero subscribers', async () => {
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'фитнес')`, TENANT_ID);
    const recs = await computeContentRecommendations(db, TENANT_ID);
    expect(recs).toEqual([]);
  });

  it('computes conversion rate correctly for a segment', async () => {
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'фитнес')`, TENANT_ID);
    await addTaggedSubscriber(db, 'sub1', 'tag1', 'client');
    await addTaggedSubscriber(db, 'sub2', 'tag1', 'client');
    await addTaggedSubscriber(db, 'sub3', 'tag1', 'new');
    await addTaggedSubscriber(db, 'sub4', 'tag1', 'in_progress');

    const [rec] = await computeContentRecommendations(db, TENANT_ID);
    expect(rec.segment).toBe('фитнес');
    expect(rec.subscriberCount).toBe(4);
    expect(rec.clientCount).toBe(2);
    expect(rec.conversionRate).toBeCloseTo(0.5);
  });

  it('matches scripts by niche, case-insensitively, and reflects it in the explanation', async () => {
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'Фитнес')`, TENANT_ID);
    await addTaggedSubscriber(db, 'sub1', 'tag1', 'client');
    await exec(
      db,
      `INSERT INTO reel_analyses (id, tenant_id, source_url, hook, duration_seconds, on_screen_text, structure)
       VALUES ('a1', ?, 'url', 'hook', 20, 'text', '[]')`,
      TENANT_ID
    );
    await exec(db, `INSERT INTO generated_scripts (id, tenant_id, analysis_id, niche, script_text) VALUES ('s1', ?, 'a1', 'фитнес', 'text')`, TENANT_ID);

    const [rec] = await computeContentRecommendations(db, TENANT_ID);
    expect(rec.matchingScriptCount).toBe(1);
    expect(rec.explanation).toContain('Уже есть 1 готовых сценариев');
  });

  it('says no ready scripts exist when the niche has none', async () => {
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'кулинария')`, TENANT_ID);
    await addTaggedSubscriber(db, 'sub1', 'tag1', 'new');

    const [rec] = await computeContentRecommendations(db, TENANT_ID);
    expect(rec.explanation).toContain('пока нет');
  });

  it('ranks higher conversion + more matching scripts first', async () => {
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag-low', ?, 'низкая')`, TENANT_ID);
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag-high', ?, 'высокая')`, TENANT_ID);
    await addTaggedSubscriber(db, 'low1', 'tag-low', 'new');
    await addTaggedSubscriber(db, 'low2', 'tag-low', 'new');
    await addTaggedSubscriber(db, 'high1', 'tag-high', 'client');
    await addTaggedSubscriber(db, 'high2', 'tag-high', 'client');

    const recs = await computeContentRecommendations(db, TENANT_ID);
    expect(recs[0].segment).toBe('высокая');
    expect(recs[1].segment).toBe('низкая');
  });

  it('one tenant\'s data never leaks into another tenant\'s recommendations', async () => {
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t2', 'T2', 't2@example.com')`);
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'фитнес')`, TENANT_ID);
    await addTaggedSubscriber(db, 'sub1', 'tag1', 'client');

    const recsForOther = await computeContentRecommendations(db, 't2');
    expect(recsForOther).toEqual([]);
  });
});

describe('GET /api/content-recommendations', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  async function createTenant(email = 'plan@example.com') {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    return res.body.apiKey as string;
  }

  it('returns recommendations built from real CRM + Module 3 data via the actual HTTP flow', async () => {
    const apiKey = await createTenant();
    const bot = await request(app).post('/api/bots').set('Authorization', `Bearer ${apiKey}`).send({ name: 'Bot', externalAccountId: 'ig-1' });
    const botId = bot.body.bot.id;

    await request(app).post('/webhooks/mock/instagram').send({
      eventId: 'e1',
      externalAccountId: 'ig-1',
      externalUserId: 'u1',
      messageText: 'привет',
    });
    const subs = await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`);
    const subscriberId = subs.body.subscribers[0].id;

    await request(app).post(`/api/subscribers/${subscriberId}/tags`).set('Authorization', `Bearer ${apiKey}`).send({ name: 'фитнес' });
    await request(app).patch(`/api/subscribers/${subscriberId}/lead-status`).set('Authorization', `Bearer ${apiKey}`).send({ leadStatus: 'client' });

    const res = await request(app).get('/api/content-recommendations').set('Authorization', `Bearer ${apiKey}`);
    expect(res.body.recommendations).toEqual([
      expect.objectContaining({ segment: 'фитнес', subscriberCount: 1, clientCount: 1, conversionRate: 1 }),
    ]);
  });

  it('filters by segment', async () => {
    const apiKey = await createTenant();
    const res = await request(app).get('/api/content-recommendations?segment=nonexistent').set('Authorization', `Bearer ${apiKey}`);
    expect(res.body.recommendations).toEqual([]);
  });
});
