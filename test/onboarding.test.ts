import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';

async function signup(app: Express, email = 'onboarding@example.com') {
  const res = await request(app).post('/api/auth/signup').send({ email, password: 'correct-horse' });
  expect(res.status).toBe(201);
  return {
    sessionToken: res.body.sessionToken as string,
    tenantId: res.body.tenant.id as string,
  };
}

async function createApiKeyTenant(app: Express, email = 'api-onboarding@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'API tenant', email });
  expect(res.status).toBe(201);
  return {
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

function bearer(credential: string) {
  return { Authorization: `Bearer ${credential}` };
}

describe('product auth and onboarding vertical slice', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('accepts a valid session JWT on product routes while preserving API-key access and error semantics', async () => {
    const session = await signup(app);
    const viaSession = await request(app).get('/api/bots').set(bearer(session.sessionToken));
    expect(viaSession.status).toBe(200);
    expect(viaSession.body.bots).toEqual([]);

    const legacy = await createApiKeyTenant(app);
    const created = await request(app)
      .post('/api/bots')
      .set(bearer(legacy.apiKey))
      .send({ name: 'Legacy API bot', externalAccountId: 'legacy-ig' });
    expect(created.status).toBe(201);

    const viaApiKey = await request(app).get('/api/bots').set(bearer(legacy.apiKey));
    expect(viaApiKey.status).toBe(200);
    expect(viaApiKey.body.bots).toEqual([
      expect.objectContaining({ id: created.body.bot.id, tenant_id: legacy.tenantId, external_account_id: 'legacy-ig' }),
    ]);

    const missing = await request(app).get('/api/bots');
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('missing_api_key');

    const invalid = await request(app).get('/api/bots').set(bearer('not-a-real-credential'));
    expect(invalid.status).toBe(401);
    expect(invalid.body.error).toBe('invalid_api_key');
  });

  it('validates non-empty demo workspace inputs', async () => {
    const { sessionToken } = await signup(app);

    const missingKeyword = await request(app)
      .post('/api/onboarding/demo-workspace')
      .set(bearer(sessionToken))
      .send({ keyword: '   ', replyText: 'Ответ' });
    expect(missingKeyword.status).toBe(400);
    expect(missingKeyword.body.error).toBe('keyword is required');

    const missingReply = await request(app)
      .post('/api/onboarding/demo-workspace')
      .set(bearer(sessionToken))
      .send({ keyword: 'цена', replyText: '\n\t' });
    expect(missingReply.status).toBe(400);
    expect(missingReply.body.error).toBe('replyText is required');
  });

  it('creates one complete demo workspace idempotently, including under concurrent calls', async () => {
    const { sessionToken, tenantId } = await signup(app);
    const create = () =>
      request(app)
        .post('/api/onboarding/demo-workspace')
        .set(bearer(sessionToken))
        .send({ keyword: ' цена ', replyText: ' Вот информация о продукте. ' });

    const [a, b] = await Promise.all([create(), create()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);

    const first = a.body;
    const second = b.body;
    expect(second.bot.id).toBe(first.bot.id);
    expect(second.flow.id).toBe(first.flow.id);
    expect(second.trigger.id).toBe(first.trigger.id);
    expect(first.bot).toMatchObject({
      tenant_id: tenantId,
      name: 'Sonar Demo',
      platform: 'instagram',
      external_account_id: `demo:${tenantId}`,
    });
    expect(first.flow).toMatchObject({ bot_id: first.bot.id, version: 1, status: 'published' });
    expect(first.flow.definition.nodes).toHaveLength(2);
    expect(first.flow.definition.edges).toEqual([
      { id: 'demo-trigger-to-message', source: 'demo-trigger-node', target: 'demo-message-node' },
    ]);
    expect(first.trigger).toMatchObject({
      bot_id: first.bot.id,
      flow_id: first.flow.id,
      flow_version: 1,
      keyword: 'цена',
      match_type: 'contains',
      is_active: true,
    });

    // A later retry with different valid defaults resumes the original
    // workspace instead of silently creating/replacing user data.
    const retry = await request(app)
      .post('/api/onboarding/demo-workspace')
      .set(bearer(sessionToken))
      .send({ keyword: 'другое', replyText: 'Другой ответ' });
    expect(retry.status).toBe(200);
    expect(retry.body.flow.id).toBe(first.flow.id);
    expect(retry.body.trigger).toMatchObject({ id: first.trigger.id, keyword: 'цена' });

    const counts = {
      bots: (
        await queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM bots WHERE tenant_id = ? AND external_account_id = ?`, tenantId, `demo:${tenantId}`)
      )!.n,
      flows: (await queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM flows WHERE bot_id = ?`, first.bot.id))!.n,
      triggers: (await queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM triggers WHERE bot_id = ?`, first.bot.id))!.n,
    };
    expect(counts).toEqual({ bots: 1, flows: 1, triggers: 1 });

    const listed = await request(app).get('/api/bots').set(bearer(sessionToken));
    expect(listed.body.bots.map((bot: { id: string }) => bot.id)).toEqual([first.bot.id]);
  });

  it('keeps /test dry but persists a demo interaction and its CRM timeline', async () => {
    const { sessionToken } = await signup(app);
    const workspace = await request(app)
      .post('/api/onboarding/demo-workspace')
      .set(bearer(sessionToken))
      .send({ keyword: 'цена', replyText: 'Стоимость зависит от выбранного формата.' });
    const botId = workspace.body.bot.id as string;

    const dryRun = await request(app)
      .post(`/api/bots/${botId}/test`)
      .set(bearer(sessionToken))
      .send({ externalUserId: 'preview-user', messageText: 'Какая цена?' });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.outcome.status).toBe('completed');

    const beforePersist = await request(app).get(`/api/bots/${botId}/subscribers`).set(bearer(sessionToken));
    expect(beforePersist.body.subscribers).toEqual([]);

    const persisted = await request(app)
      .post(`/api/bots/${botId}/demo-interactions`)
      .set(bearer(sessionToken))
      .send({ messageText: '  Какая цена?  ' });
    expect(persisted.status).toBe(200);
    expect(persisted.body.subscriberId).toEqual(expect.any(String));
    expect(persisted.body.outcome).toMatchObject({
      status: 'completed',
      sentMessages: [{ channel: 'dm', content: 'Стоимость зависит от выбранного формата.' }],
    });

    const subscribers = await request(app).get(`/api/bots/${botId}/subscribers`).set(bearer(sessionToken));
    expect(subscribers.body.subscribers).toHaveLength(1);
    expect(subscribers.body.subscribers[0]).toMatchObject({
      id: persisted.body.subscriberId,
      external_user_id: 'sonar-demo-contact',
      lead_status: 'new',
    });

    const timeline = await request(app)
      .get(`/api/subscribers/${persisted.body.subscriberId}/messages`)
      .set(bearer(sessionToken));
    expect(timeline.body.messages).toEqual([
      { direction: 'in', content: 'Какая цена?', created_at: expect.any(String) },
      { direction: 'out', content: 'Стоимость зависит от выбранного формата.', created_at: expect.any(String) },
    ]);
  });

  it('validates demo messages and refuses the endpoint for regular or cross-tenant bots', async () => {
    const owner = await signup(app, 'demo-owner@example.com');
    const other = await signup(app, 'demo-other@example.com');
    const workspace = await request(app)
      .post('/api/onboarding/demo-workspace')
      .set(bearer(owner.sessionToken))
      .send({ keyword: 'цена', replyText: 'Ответ' });

    const empty = await request(app)
      .post(`/api/bots/${workspace.body.bot.id}/demo-interactions`)
      .set(bearer(owner.sessionToken))
      .send({ messageText: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('messageText is required');

    const regular = await request(app)
      .post('/api/bots')
      .set(bearer(owner.sessionToken))
      .send({ name: 'Regular bot', externalAccountId: 'ig-regular' });
    const forbidden = await request(app)
      .post(`/api/bots/${regular.body.bot.id}/demo-interactions`)
      .set(bearer(owner.sessionToken))
      .send({ messageText: 'цена' });
    expect(forbidden.status).toBe(403);

    const hidden = await request(app)
      .post(`/api/bots/${workspace.body.bot.id}/demo-interactions`)
      .set(bearer(other.sessionToken))
      .send({ messageText: 'цена' });
    expect(hidden.status).toBe(404);
  });
});
