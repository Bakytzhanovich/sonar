import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';

function basicDefinition(overrides: { emptyText?: boolean } = {}) {
  return {
    nodes: [
      { id: 'trig', type: 'trigger', position: { x: 0, y: 0 }, data: { keyword: 'цена', matchType: 'contains' } },
      { id: 'msg1', type: 'send_message', position: { x: 0, y: 100 }, data: { text: overrides.emptyText ? '' : 'Вот цена' } },
    ],
    edges: [{ id: 'e1', source: 'trig', target: 'msg1' }],
  };
}

async function createTenant(app: Express, email = 't@example.com') {
  const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
  // Checked before reading the body. Without this a route that answers
  // anything but 201 — a closed credential gate, a database error — surfaces
  // as "cannot read properties of undefined (reading 'id')" from whichever
  // test happened to call this, which says nothing about what went wrong.
  if (res.status !== 201) {
    throw new Error(`POST /api/tenants answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return { apiKey: res.body.apiKey as string, tenantId: res.body.tenant.id as string };
}

async function createBot(app: Express, apiKey: string, externalAccountId = 'ig-1') {
  const res = await request(app)
    .post('/api/bots')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name: 'My Bot', externalAccountId });
  return res.body.bot.id as string;
}

async function createPublishedFlow(app: Express, apiKey: string, botId: string) {
  const created = await request(app)
    .post(`/api/bots/${botId}/flows`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ definition: basicDefinition() });
  const { id, version } = created.body.flow;

  await request(app)
    .post(`/api/flows/${id}/versions/${version}/publish`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send();

  return { flowId: id as string, flowVersion: version as number };
}

describe('api', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('rejects requests with no API key', async () => {
    const res = await request(app).post('/api/bots').send({ name: 'Bot' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_api_key');
  });

  it('rejects requests with a wrong API key', async () => {
    const res = await request(app).post('/api/bots').set('Authorization', 'Bearer not-a-real-key').send({ name: 'Bot' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_api_key');
  });

  it('rejects publishing a flow with no trigger node', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const created = await request(app)
      .post(`/api/bots/${botId}/flows`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: { nodes: [], edges: [] } });

    const publish = await request(app)
      .post(`/api/flows/${created.body.flow.id}/versions/1/publish`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send();

    expect(publish.status).toBe(422);
    expect(publish.body.errors).toContain('flow must have exactly one trigger node, found 0');
  });

  it('refuses to bind a trigger to an unpublished flow', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const created = await request(app)
      .post(`/api/bots/${botId}/flows`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: basicDefinition() });

    const res = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId: created.body.flow.id, flowVersion: 1 });

    expect(res.status).toBe(422);
  });

  it('refuses a second trigger on the same bot for a keyword that already has one', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, apiKey, botId);

    const first = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'X', flowId, flowVersion });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'X', flowId, flowVersion });

    expect(second.status).toBe(409);
  });

  it('treats keywords that only differ by case or surrounding whitespace as the same conflict', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, apiKey, botId);

    const first = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'Цена', flowId, flowVersion });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: ' цена ', flowId, flowVersion });

    expect(second.status).toBe(409);
  });

  it('under true concurrency, exactly one of two simultaneous same-keyword binds succeeds (DB constraint, not just the pre-check)', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, apiKey, botId);

    // Fired via Promise.all, not awaited one after another — both requests'
    // pre-check SELECT can race before either INSERT lands. If only the
    // app-level pre-check existed (no idx_triggers_bot_keyword_unique),
    // this would be flaky/both-201 under load; the UNIQUE index is what
    // guarantees exactly one winner regardless of interleaving.
    const [a, b] = await Promise.all([
      request(app).post(`/api/bots/${botId}/triggers`).set('Authorization', `Bearer ${apiKey}`).send({ keyword: 'гонка', flowId, flowVersion }),
      request(app).post(`/api/bots/${botId}/triggers`).set('Authorization', `Bearer ${apiKey}`).send({ keyword: 'гонка', flowId, flowVersion }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('allows the same keyword on two different bots (conflict check is per-bot)', async () => {
    const { apiKey } = await createTenant(app);
    const botA = await createBot(app, apiKey, 'ig-a');
    const botB = await createBot(app, apiKey, 'ig-b');
    const flowA = await createPublishedFlow(app, apiKey, botA);
    const flowB = await createPublishedFlow(app, apiKey, botB);

    const onA = await request(app)
      .post(`/api/bots/${botA}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId: flowA.flowId, flowVersion: flowA.flowVersion });
    const onB = await request(app)
      .post(`/api/bots/${botB}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId: flowB.flowId, flowVersion: flowB.flowVersion });

    expect(onA.status).toBe(201);
    expect(onB.status).toBe(201);
  });

  it('one tenant cannot see or act on another tenant\'s bot', async () => {
    const owner = await createTenant(app, 'owner@example.com');
    const intruder = await createTenant(app, 'intruder@example.com');
    const botId = await createBot(app, owner.apiKey);

    const res = await request(app)
      .get(`/api/bots/${botId}/dashboard`)
      .set('Authorization', `Bearer ${intruder.apiKey}`);

    expect(res.status).toBe(404);
  });

  it('runs the full happy path: bot -> flow -> publish -> trigger -> test run -> mock webhook -> dashboard', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, apiKey, botId);

    const trigger = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId, flowVersion });
    expect(trigger.status).toBe(201);

    const testRun = await request(app)
      .post(`/api/bots/${botId}/test`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ externalUserId: 'test-user', messageText: 'цена?' });
    expect(testRun.body.outcome.status).toBe('completed');

    const webhook = await request(app).post('/webhooks/mock/instagram').set('x-sonar-webhook-secret', 'test-mock-webhook-secret').send({
      eventId: 'evt-1',
      externalAccountId: 'ig-1',
      externalUserId: 'real-user-1',
      messageText: 'а сколько цена?',
    });
    expect(webhook.body.outcome.status).toBe('completed');

    const dashboard = await request(app)
      .get(`/api/bots/${botId}/dashboard`)
      .set('Authorization', `Bearer ${apiKey}`);

    // Only the real webhook run should be counted — the test-mode run above
    // wrote nothing to the database.
    expect(dashboard.body.subscriberCount).toBe(1);
    expect(dashboard.body.runsByStatus).toEqual([{ status: 'completed', n: 1 }]);
  });

  it('mock webhook is idempotent on repeated event_id delivery', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, apiKey, botId);
    await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId, flowVersion });

    const payload = { eventId: 'evt-dup', externalAccountId: 'ig-1', externalUserId: 'user-1', messageText: 'цена?' };
    const first = await request(app).post('/webhooks/mock/instagram').set('x-sonar-webhook-secret', 'test-mock-webhook-secret').send(payload);
    const second = await request(app).post('/webhooks/mock/instagram').set('x-sonar-webhook-secret', 'test-mock-webhook-secret').send(payload);

    expect(first.body.outcome.status).toBe('completed');
    expect(second.body).toEqual({ status: 'already_processed' });

    const dashboard = await request(app)
      .get(`/api/bots/${botId}/dashboard`)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(dashboard.body.runsByStatus).toEqual([{ status: 'completed', n: 1 }]);
  });
});

describe('loading flows back (needed for the canvas editor)', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('lists all flow versions for a bot', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId } = await createPublishedFlow(app, apiKey, botId);
    await request(app)
      .post(`/api/flows/${flowId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: basicDefinition() });

    const res = await request(app).get(`/api/bots/${botId}/flows`).set('Authorization', `Bearer ${apiKey}`);

    expect(res.body.flows).toEqual([
      { id: flowId, version: 2, status: 'draft', created_at: expect.any(String) },
      { id: flowId, version: 1, status: 'published', created_at: expect.any(String) },
    ]);
  });

  it('fetches one version definition, and 404s for another tenant', async () => {
    const owner = await createTenant(app, 'owner3@example.com');
    const intruder = await createTenant(app, 'intruder3@example.com');
    const botId = await createBot(app, owner.apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, owner.apiKey, botId);

    const ok = await request(app)
      .get(`/api/flows/${flowId}/versions/${flowVersion}`)
      .set('Authorization', `Bearer ${owner.apiKey}`);
    expect(ok.body.flow.definition.nodes).toHaveLength(2);

    const blocked = await request(app)
      .get(`/api/flows/${flowId}/versions/${flowVersion}`)
      .set('Authorization', `Bearer ${intruder.apiKey}`);
    expect(blocked.status).toBe(404);
  });
});

describe('flow versioning and rollback', () => {
  let app: Express;
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('adds an incrementing new version to an existing flow', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId } = await createPublishedFlow(app, apiKey, botId);

    const v2 = await request(app)
      .post(`/api/flows/${flowId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: basicDefinition() });
    expect(v2.body.flow).toEqual({ id: flowId, version: 2, status: 'draft' });

    const v3 = await request(app)
      .post(`/api/flows/${flowId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: basicDefinition() });
    expect(v3.body.flow.version).toBe(3);
  });

  it('under true concurrency, no two simultaneous new-version calls ever land on the same version number (DB constraint, not just the pre-check)', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId } = await createPublishedFlow(app, apiKey, botId);

    // This endpoint's only pre-write step is one SELECT MAX(version), so a
    // single pair of concurrent calls usually doesn't actually overlap —
    // confirmed empirically (2-way Promise.all serialized 3/3 runs here,
    // and even against a live server most 2-way attempts didn't collide
    // either). 8-way concurrency reliably does force real collisions
    // (verified: every run produces several requests reading the same
    // pre-write maxVersion and racing for the same next version number) —
    // that's the actual proof this needs, not a fixed 201/409 split from
    // just two calls, which would pass even if the DB constraint were
    // silently removed.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).post(`/api/flows/${flowId}/versions`).set('Authorization', `Bearer ${apiKey}`).send({ definition: basicDefinition() })
      )
    );

    const successes = results.filter((r) => r.status === 201);
    const failures = results.filter((r) => r.status !== 201);
    // Genuine contention must have been hit — otherwise this test isn't
    // actually exercising the race at all.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((r) => r.status === 409)).toBe(true); // never a bare 500

    // flows(id, version)'s composite PRIMARY KEY is the real guarantee:
    // no matter how many requests computed the same nextVersion, at most
    // one of them can ever have actually inserted it.
    const versions = successes.map((r) => r.body.flow.version);
    expect(new Set(versions).size).toBe(versions.length);

    const listed = await request(app).get(`/api/bots/${botId}/flows`).set('Authorization', `Bearer ${apiKey}`);
    expect(listed.body.flows.filter((f: { id: string }) => f.id === flowId)).toHaveLength(1 + successes.length); // v1 + each real winner
  });

  it('rolls a trigger back to an earlier published version', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId } = await createPublishedFlow(app, apiKey, botId); // v1, published

    const v2 = await request(app)
      .post(`/api/flows/${flowId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: basicDefinition() });
    await request(app)
      .post(`/api/flows/${flowId}/versions/2/publish`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send();

    // Trigger is currently live on the newer, v2.
    const trigger = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId, flowVersion: v2.body.flow.version });
    expect(trigger.body.trigger.flow_version).toBe(2);

    const rollback = await request(app)
      .post(`/api/triggers/${trigger.body.trigger.id}/rollback`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ toVersion: 1 });

    expect(rollback.status).toBe(200);
    expect(rollback.body.trigger.flow_version).toBe(1);
  });

  it('refuses to roll back to a version that was never published', async () => {
    const { apiKey } = await createTenant(app);
    const botId = await createBot(app, apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, apiKey, botId);

    await request(app)
      .post(`/api/flows/${flowId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ definition: basicDefinition() }); // v2, left as draft

    const trigger = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ keyword: 'цена', flowId, flowVersion });

    const rollback = await request(app)
      .post(`/api/triggers/${trigger.body.trigger.id}/rollback`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ toVersion: 2 });

    expect(rollback.status).toBe(422);
  });

  it('one tenant cannot roll back another tenant\'s trigger', async () => {
    const owner = await createTenant(app, 'owner2@example.com');
    const intruder = await createTenant(app, 'intruder2@example.com');
    const botId = await createBot(app, owner.apiKey);
    const { flowId, flowVersion } = await createPublishedFlow(app, owner.apiKey, botId);

    const trigger = await request(app)
      .post(`/api/bots/${botId}/triggers`)
      .set('Authorization', `Bearer ${owner.apiKey}`)
      .send({ keyword: 'цена', flowId, flowVersion });

    const rollback = await request(app)
      .post(`/api/triggers/${trigger.body.trigger.id}/rollback`)
      .set('Authorization', `Bearer ${intruder.apiKey}`)
      .send({ toVersion: 1 });

    expect(rollback.status).toBe(404);
  });
});
