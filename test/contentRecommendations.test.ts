import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb } from '../src/db';
import { createApp } from '../src/api';
import { computeContentRecommendations } from '../src/contentRecommendations';
import type Database from 'better-sqlite3';

const TENANT_ID = 't1';
const BOT_ID = 'bot1';

function seedTenantAndBot(db: Database.Database) {
  db.prepare(`INSERT INTO tenants (id, name, email) VALUES (?, 'T', 't@example.com')`).run(TENANT_ID);
  db.prepare(`INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES (?, ?, 'Bot', 'ig-1')`).run(BOT_ID, TENANT_ID);
}

function addTaggedSubscriber(db: Database.Database, id: string, tagId: string, leadStatus: string) {
  db.prepare(
    `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, lead_status) VALUES (?, ?, ?, ?, ?)`
  ).run(id, TENANT_ID, BOT_ID, id, leadStatus);
  db.prepare(`INSERT INTO subscriber_tags (subscriber_id, tag_id) VALUES (?, ?)`).run(id, tagId);
}

describe('computeContentRecommendations (pure logic)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb({ filePath: ':memory:' });
    seedTenantAndBot(db);
  });

  it('skips tags with zero subscribers', () => {
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'фитнес')`).run(TENANT_ID);
    const recs = computeContentRecommendations(db, TENANT_ID);
    expect(recs).toEqual([]);
  });

  it('computes conversion rate correctly for a segment', () => {
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'фитнес')`).run(TENANT_ID);
    addTaggedSubscriber(db, 'sub1', 'tag1', 'client');
    addTaggedSubscriber(db, 'sub2', 'tag1', 'client');
    addTaggedSubscriber(db, 'sub3', 'tag1', 'new');
    addTaggedSubscriber(db, 'sub4', 'tag1', 'in_progress');

    const [rec] = computeContentRecommendations(db, TENANT_ID);
    expect(rec.segment).toBe('фитнес');
    expect(rec.subscriberCount).toBe(4);
    expect(rec.clientCount).toBe(2);
    expect(rec.conversionRate).toBeCloseTo(0.5);
  });

  it('matches scripts by niche, case-insensitively, and reflects it in the explanation', () => {
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'Фитнес')`).run(TENANT_ID);
    addTaggedSubscriber(db, 'sub1', 'tag1', 'client');
    db.prepare(
      `INSERT INTO reel_analyses (id, tenant_id, source_url, hook, duration_seconds, on_screen_text, structure)
       VALUES ('a1', ?, 'url', 'hook', 20, 'text', '[]')`
    ).run(TENANT_ID);
    db.prepare(
      `INSERT INTO generated_scripts (id, tenant_id, analysis_id, niche, script_text) VALUES ('s1', ?, 'a1', 'фитнес', 'text')`
    ).run(TENANT_ID);

    const [rec] = computeContentRecommendations(db, TENANT_ID);
    expect(rec.matchingScriptCount).toBe(1);
    expect(rec.explanation).toContain('Уже есть 1 готовых сценариев');
  });

  it('says no ready scripts exist when the niche has none', () => {
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'кулинария')`).run(TENANT_ID);
    addTaggedSubscriber(db, 'sub1', 'tag1', 'new');

    const [rec] = computeContentRecommendations(db, TENANT_ID);
    expect(rec.explanation).toContain('пока нет');
  });

  it('ranks higher conversion + more matching scripts first', () => {
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag-low', ?, 'низкая')`).run(TENANT_ID);
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag-high', ?, 'высокая')`).run(TENANT_ID);
    addTaggedSubscriber(db, 'low1', 'tag-low', 'new');
    addTaggedSubscriber(db, 'low2', 'tag-low', 'new');
    addTaggedSubscriber(db, 'high1', 'tag-high', 'client');
    addTaggedSubscriber(db, 'high2', 'tag-high', 'client');

    const recs = computeContentRecommendations(db, TENANT_ID);
    expect(recs[0].segment).toBe('высокая');
    expect(recs[1].segment).toBe('низкая');
  });

  it('one tenant\'s data never leaks into another tenant\'s recommendations', () => {
    db.prepare(`INSERT INTO tenants (id, name, email) VALUES ('t2', 'T2', 't2@example.com')`).run();
    db.prepare(`INSERT INTO tags (id, tenant_id, name) VALUES ('tag1', ?, 'фитнес')`).run(TENANT_ID);
    addTaggedSubscriber(db, 'sub1', 'tag1', 'client');

    const recsForOther = computeContentRecommendations(db, 't2');
    expect(recsForOther).toEqual([]);
  });
});

describe('GET /api/content-recommendations', () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(createDb({ filePath: ':memory:' }));
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
