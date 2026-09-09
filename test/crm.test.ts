import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function createTenant(app: Express, email = 'crm@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  return { apiKey: res.body.apiKey as string, tenantId: res.body.tenant.id as string };
}

async function createBot(app: Express, apiKey: string, externalAccountId = 'ig-crm') {
  const res = await request(app)
    .post('/api/bots')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name: 'CRM Bot', externalAccountId });
  return res.body.bot.id as string;
}

// Drives a subscriber into existence the same way a real user would —
// through the mock webhook — since there's no direct "create subscriber"
// endpoint (subscribers only ever come from real interactions).
async function messageBot(app: Express, externalAccountId: string, externalUserId: string, messageText: string, eventId: string) {
  return request(app).post('/webhooks/mock/instagram').send({ eventId, externalAccountId, externalUserId, messageText });
}

describe('CRM: subscribers, tags, notes, timeline', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('lists a subscriber created by a non-matching message (no trigger needed)', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет, просто вопрос', 'evt-1');

    const res = await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`);
    expect(res.body.subscribers).toHaveLength(1);
    expect(res.body.subscribers[0]).toMatchObject({ external_user_id: 'u1', lead_status: 'new', tags: [] });
  });

  it('gets a subscriber profile and updates lead status', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет', 'evt-1');
    const subscriberId = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body
      .subscribers[0].id;

    const updated = await request(app)
      .patch(`/api/subscribers/${subscriberId}/lead-status`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ leadStatus: 'client' });
    expect(updated.body.subscriber.lead_status).toBe('client');

    const rejected = await request(app)
      .patch(`/api/subscribers/${subscriberId}/lead-status`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ leadStatus: 'not_a_real_status' });
    expect(rejected.status).toBe(400);
  });

  it('adds and removes tags, reusing an existing tag by name instead of duplicating it', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет', 'evt-1');
    const subscriberId = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body
      .subscribers[0].id;

    const tag1 = await request(app).post(`/api/subscribers/${subscriberId}/tags`).set('Authorization', `Bearer ${apiKey}`).send({ name: 'vip' });
    expect(tag1.status).toBe(201);

    // Second subscriber, same tag name -> should reuse the same tag id, not create a duplicate.
    await messageBot(app, 'ig-crm', 'u2', 'привет', 'evt-2');
    const subscriber2Id = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body
      .subscribers.find((s: { external_user_id: string }) => s.external_user_id === 'u2').id;
    const tag2 = await request(app).post(`/api/subscribers/${subscriber2Id}/tags`).set('Authorization', `Bearer ${apiKey}`).send({ name: 'vip' });
    expect(tag2.body.tag.id).toBe(tag1.body.tag.id);

    const filtered = await request(app).get(`/api/bots/${botId}/subscribers?tag=vip`).set('Authorization', `Bearer ${apiKey}`);
    expect(filtered.body.subscribers).toHaveLength(2);

    await request(app).delete(`/api/subscribers/${subscriberId}/tags/${tag1.body.tag.id}`).set('Authorization', `Bearer ${apiKey}`);
    const afterRemoval = await request(app).get(`/api/bots/${botId}/subscribers?tag=vip`).set('Authorization', `Bearer ${apiKey}`);
    expect(afterRemoval.body.subscribers).toHaveLength(1);
  });

  it('under true concurrency, two simultaneous tag creates with the same name resolve to one tag, not a duplicate', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет', 'evt-1');
    await messageBot(app, 'ig-crm', 'u2', 'привет', 'evt-2');
    const subs = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body.subscribers;
    const sub1Id = subs.find((s: { external_user_id: string }) => s.external_user_id === 'u1').id;
    const sub2Id = subs.find((s: { external_user_id: string }) => s.external_user_id === 'u2').id;

    // Fired via Promise.all, not awaited one after another — both requests'
    // pre-check SELECT can read "no tag named 'гонка' yet" before either
    // INSERT lands. Unlike the trigger-keyword race, a duplicate tag name
    // is not a business conflict here — the handler's catch block treats
    // the loser's UNIQUE(tenant_id, name) violation as "someone already
    // created it, use that row", so BOTH callers are expected to succeed,
    // just against the same tag id, not one 201 + one 409.
    const [a, b] = await Promise.all([
      request(app).post(`/api/subscribers/${sub1Id}/tags`).set('Authorization', `Bearer ${apiKey}`).send({ name: 'гонка' }),
      request(app).post(`/api/subscribers/${sub2Id}/tags`).set('Authorization', `Bearer ${apiKey}`).send({ name: 'гонка' }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.tag.id).toBe(b.body.tag.id);

    const tags = await request(app).get(`/api/bots/${botId}/tags`).set('Authorization', `Bearer ${apiKey}`);
    expect(tags.body.tags.filter((t: { name: string }) => t.name === 'гонка')).toHaveLength(1);
  });

  it('filters subscribers by leadStatus', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет', 'evt-1');
    const subscriberId = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body
      .subscribers[0].id;
    await request(app).patch(`/api/subscribers/${subscriberId}/lead-status`).set('Authorization', `Bearer ${apiKey}`).send({ leadStatus: 'client' });

    const clients = await request(app).get(`/api/bots/${botId}/subscribers?leadStatus=client`).set('Authorization', `Bearer ${apiKey}`);
    expect(clients.body.subscribers).toHaveLength(1);

    const newOnes = await request(app).get(`/api/bots/${botId}/subscribers?leadStatus=new`).set('Authorization', `Bearer ${apiKey}`);
    expect(newOnes.body.subscribers).toHaveLength(0);
  });

  it('adds notes to a subscriber, newest first', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет', 'evt-1');
    const subscriberId = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body
      .subscribers[0].id;

    await request(app).post(`/api/subscribers/${subscriberId}/notes`).set('Authorization', `Bearer ${apiKey}`).send({ body: 'Первая заметка' });
    await request(app).post(`/api/subscribers/${subscriberId}/notes`).set('Authorization', `Bearer ${apiKey}`).send({ body: 'Вторая заметка' });

    const notes = await request(app).get(`/api/subscribers/${subscriberId}/notes`).set('Authorization', `Bearer ${apiKey}`);
    expect(notes.body.notes.map((n: { body: string }) => n.body)).toEqual(['Вторая заметка', 'Первая заметка']);
  });

  it('returns the full conversation timeline including non-matching messages', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'просто привет, без триггера', 'evt-1');
    const subscriberId = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${apiKey}`)).body
      .subscribers[0].id;

    const timeline = await request(app).get(`/api/subscribers/${subscriberId}/messages`).set('Authorization', `Bearer ${apiKey}`);
    expect(timeline.body.messages).toEqual([{ direction: 'in', content: 'просто привет, без триггера', created_at: expect.any(String) }]);
  });

  it('one tenant cannot read or modify another tenant\'s subscriber', async () => {
    const owner = await createTenant(app, 'owner-crm@example.com');
    const intruder = await createTenant(app, 'intruder-crm@example.com');
    const botId = await createBot(app, owner.apiKey);
    await messageBot(app, 'ig-crm', 'u1', 'привет', 'evt-1');
    const subscriberId = (await request(app).get(`/api/bots/${botId}/subscribers`).set('Authorization', `Bearer ${owner.apiKey}`)).body
      .subscribers[0].id;

    const read = await request(app).get(`/api/subscribers/${subscriberId}`).set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(read.status).toBe(404);

    const write = await request(app)
      .patch(`/api/subscribers/${subscriberId}/lead-status`)
      .set('Authorization', `Bearer ${intruder.apiKey}`)
      .send({ leadStatus: 'client' });
    expect(write.status).toBe(404);
  });
});
