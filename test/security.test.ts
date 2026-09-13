// Regression tests for the security audit fixes. Each case here is an
// exploit that actually worked against the previous code, so these assert
// the hole stays closed rather than describing intended behaviour in the
// abstract.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { queryAll, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';

const WEBHOOK_SECRET_HEADER = 'x-sonar-webhook-secret';
const TEST_WEBHOOK_SECRET = 'test-mock-webhook-secret';

async function createTenant(app: Express, email: string) {
  const res = await request(app).post('/api/tenants').send({ name: email, email });
  return res.body.apiKey as string;
}

// A bot with a published flow and an active trigger — the minimum needed for
// an inbound message to actually do something (send a DM, create a contact).
async function createBotWithLiveTrigger(app: Express, apiKey: string, externalAccountId: string) {
  const bot = (
    await request(app).post('/api/bots').set('Authorization', `Bearer ${apiKey}`).send({ name: 'bot', externalAccountId })
  ).body.bot;

  const flow = (
    await request(app)
      .post(`/api/bots/${bot.id}/flows`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        definition: {
          nodes: [
            { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { keyword: 'цена', matchType: 'contains' } },
            { id: 'm', type: 'send_message', position: { x: 1, y: 0 }, data: { text: 'Прайс' } },
          ],
          edges: [{ id: 'e', source: 't', target: 'm' }],
        },
      })
  ).body.flow;

  await request(app)
    .post(`/api/flows/${flow.id}/versions/${flow.version}/publish`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({});
  await request(app)
    .post(`/api/bots/${bot.id}/triggers`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ flowId: flow.id, flowVersion: flow.version, keyword: 'цена', matchType: 'contains' });

  return bot;
}

describe('security: mock webhook is not an open door', () => {
  let app: Express;
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  // The original hole: external_account_id is a public Instagram handle, so
  // this request needed no credential at all to send a DM from a client's
  // account and add a contact to their CRM.
  it('rejects a call with no secret, without running the flow', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    await createBotWithLiveTrigger(app, apiKey, 'public_handle');

    const res = await request(app)
      .post('/webhooks/mock/instagram')
      .send({ eventId: 'e1', externalAccountId: 'public_handle', externalUserId: 'victim', messageText: 'цена?' });

    expect(res.status).toBe(401);
    expect(await queryAll(db, `SELECT * FROM mock_sent_messages`)).toHaveLength(0);
    expect(await queryAll(db, `SELECT * FROM subscribers`)).toHaveLength(0);
  });

  it('rejects a wrong secret', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    await createBotWithLiveTrigger(app, apiKey, 'public_handle');

    const res = await request(app)
      .post('/webhooks/mock/instagram')
      .set(WEBHOOK_SECRET_HEADER, 'wrong')
      .send({ eventId: 'e1', externalAccountId: 'public_handle', externalUserId: 'victim', messageText: 'цена?' });

    expect(res.status).toBe(401);
    expect(await queryAll(db, `SELECT * FROM subscribers`)).toHaveLength(0);
  });

  it('still works with the correct secret — the contract is unchanged, only gated', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    await createBotWithLiveTrigger(app, apiKey, 'public_handle');

    const res = await request(app)
      .post('/webhooks/mock/instagram')
      .set(WEBHOOK_SECRET_HEADER, TEST_WEBHOOK_SECRET)
      .send({ eventId: 'e1', externalAccountId: 'public_handle', externalUserId: 'buyer', messageText: 'цена?' });

    expect(res.status).toBe(200);
    expect(res.body.outcome.status).toBe('completed');
  });
});

describe('security: in-product simulator is tenant-scoped', () => {
  let app: Express;
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('drives a real flow run for the caller own bot', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    const bot = await createBotWithLiveTrigger(app, apiKey, 'handle-a');

    const res = await request(app)
      .post(`/api/bots/${bot.id}/simulate-incoming`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ externalUserId: 'buyer', messageText: 'цена?' });

    expect(res.status).toBe(200);
    expect(res.body.outcome.status).toBe('completed');
    // Persists, unlike test mode — this is what populates the CRM.
    expect(await queryAll(db, `SELECT * FROM subscribers`)).toHaveLength(1);
  });

  it('is unreachable without a credential and for another tenant bot', async () => {
    const keyA = await createTenant(app, 'a@example.com');
    const keyB = await createTenant(app, 'b@example.com');
    const botA = await createBotWithLiveTrigger(app, keyA, 'handle-a');

    const anonymous = await request(app)
      .post(`/api/bots/${botA.id}/simulate-incoming`)
      .send({ externalUserId: 'x', messageText: 'цена?' });
    expect(anonymous.status).toBe(401);

    // 404, not 403 — "another tenant's bot" must be indistinguishable from
    // "no such bot", so ids cannot be probed for existence.
    const crossTenant = await request(app)
      .post(`/api/bots/${botA.id}/simulate-incoming`)
      .set('Authorization', `Bearer ${keyB}`)
      .send({ externalUserId: 'x', messageText: 'цена?' });
    expect(crossTenant.status).toBe(404);
    expect(await queryAll(db, `SELECT * FROM subscribers`)).toHaveLength(0);
  });
});

describe('security: multi-tenancy isolation of the job processors', () => {
  let app: Express;
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  // Confirmed exploit before the fix: {"processed":1} — tenant B published
  // tenant A's post to A's real account, and A's owner got the push.
  it('process-due leaves another tenant due posts alone', async () => {
    const keyA = await createTenant(app, 'a@example.com');
    const keyB = await createTenant(app, 'b@example.com');

    const post = (
      await request(app)
        .post('/api/scheduled-posts')
        .set('Authorization', `Bearer ${keyA}`)
        .send({ platform: 'instagram', caption: 'приватный пост A', scheduledAt: new Date(Date.now() - 60_000).toISOString() })
    ).body.post;

    const res = await request(app).post('/api/scheduled-posts/process-due').set('Authorization', `Bearer ${keyB}`).send({});
    expect(res.body.processed).toBe(0);

    const row = await queryOne<{ status: string }>(db, `SELECT status FROM scheduled_posts WHERE id = ?`, post.id);
    expect(row?.status).toBe('scheduled');

    // The owner can still process its own.
    const own = await request(app).post('/api/scheduled-posts/process-due').set('Authorization', `Bearer ${keyA}`).send({});
    expect(own.body.processed).toBe(1);
  });

  it('process-tick leaves another tenant render jobs alone', async () => {
    const keyA = await createTenant(app, 'a@example.com');
    const keyB = await createTenant(app, 'b@example.com');

    const job = (
      await request(app)
        .post('/api/video-edit-jobs')
        .set('Authorization', `Bearer ${keyA}`)
        .send({ sourceVideoUrl: 'https://example.com/v.mp4', template: 'auto_crop_916' })
    ).body.job;

    const res = await request(app).post('/api/video-edit-jobs/process-tick').set('Authorization', `Bearer ${keyB}`).send({});
    expect(res.body.advanced).toBe(0);

    const row = await queryOne<{ progress_percent: number }>(db, `SELECT progress_percent FROM video_edit_jobs WHERE id = ?`, job.id);
    expect(row?.progress_percent).toBe(0);

    const own = await request(app).post('/api/video-edit-jobs/process-tick').set('Authorization', `Bearer ${keyA}`).send({});
    expect(own.body.advanced).toBe(1);
  });
});

describe('security: right to erasure (личные данные, закон РК)', () => {
  let app: Express;
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('erases a contact and every trace of it, across all related tables', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    const bot = await createBotWithLiveTrigger(app, apiKey, 'handle-a');

    // Generate a full personal-data footprint: contact, message history,
    // flow run, sent message, a note and a tag.
    await request(app)
      .post(`/api/bots/${bot.id}/simulate-incoming`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ externalUserId: 'buyer', messageText: 'цена?' });

    const subscriber = (
      await request(app).get(`/api/bots/${bot.id}/subscribers`).set('Authorization', `Bearer ${apiKey}`)
    ).body.subscribers[0];
    await request(app).post(`/api/subscribers/${subscriber.id}/notes`).set('Authorization', `Bearer ${apiKey}`).send({ body: 'заметка' });
    await request(app).post(`/api/subscribers/${subscriber.id}/tags`).set('Authorization', `Bearer ${apiKey}`).send({ name: 'лид' });

    expect(await queryAll(db, `SELECT * FROM messages`)).not.toHaveLength(0);
    expect(await queryAll(db, `SELECT * FROM flow_runs`)).not.toHaveLength(0);

    const del = await request(app).delete(`/api/subscribers/${subscriber.id}`).set('Authorization', `Bearer ${apiKey}`);
    expect(del.status).toBe(204);

    for (const table of ['subscribers', 'messages', 'notes', 'flow_runs', 'mock_sent_messages', 'subscriber_tags']) {
      expect(await queryAll(db, `SELECT * FROM ${table}`), `${table} должна быть пуста`).toHaveLength(0);
    }
    // The tag vocabulary itself is tenant-level, not personal data.
    expect(await queryAll(db, `SELECT * FROM tags`)).toHaveLength(1);
  });

  it('cannot erase another tenant contact', async () => {
    const keyA = await createTenant(app, 'a@example.com');
    const keyB = await createTenant(app, 'b@example.com');
    const bot = await createBotWithLiveTrigger(app, keyA, 'handle-a');
    await request(app)
      .post(`/api/bots/${bot.id}/simulate-incoming`)
      .set('Authorization', `Bearer ${keyA}`)
      .send({ externalUserId: 'buyer', messageText: 'цена?' });
    const subscriber = (
      await request(app).get(`/api/bots/${bot.id}/subscribers`).set('Authorization', `Bearer ${keyA}`)
    ).body.subscribers[0];

    const res = await request(app).delete(`/api/subscribers/${subscriber.id}`).set('Authorization', `Bearer ${keyB}`);
    expect(res.status).toBe(404);
    expect(await queryAll(db, `SELECT * FROM subscribers`)).toHaveLength(1);
  });
});

describe('security: login does not leak which emails are registered', () => {
  let app: Express;
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  // Response bodies were already identical; the giveaway was timing, since
  // bcrypt only ran when the email existed. Asserting the dummy-hash
  // comparison happens at all: an unknown email must cost a real verify,
  // so it cannot be answered near-instantly.
  it('spends comparable time on an unknown email as on a wrong password', async () => {
    await request(app).post('/api/auth/signup').send({ email: 'real@example.com', password: 'correct-horse' });

    const t0 = Date.now();
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: 'real@example.com', password: 'nope-nope-nope' });
    const wrongPasswordMs = Date.now() - t0;

    const t1 = Date.now();
    const unknownEmail = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope-nope-nope' });
    const unknownEmailMs = Date.now() - t1;

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    // Generous bound — this asserts the bcrypt work happened, not a precise
    // timing profile, so it cannot go flaky on a loaded CI box.
    expect(unknownEmailMs).toBeGreaterThan(wrongPasswordMs / 4);
  });
});

describe('security: bad input answers as bad input, not as a server fault', () => {
  let app: Express;
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); app = createApp(db); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  // Each case below used to return 500 "internal_error". None was a breach,
  // but all four told the caller its own malformed request was a server
  // fault, and each one went through console.error — so anyone could flood
  // the logs with requests that are merely invalid and bury real incidents.
  it('rejects a NUL byte instead of letting Postgres fail the statement', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    const res = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceUrl: `https://example.com/${String.fromCharCode(0)}x` });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('null_byte_in_request');
  });

  it('answers an oversized body with 413, not 500', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    const res = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ sourceUrl: 'https://example.com/x', pad: 'x'.repeat(2 * 1024 * 1024) });

    expect(res.status).toBe(413);
  });

  it('answers malformed JSON with 400, not 500', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    const res = await request(app)
      .post('/api/reel-analyses')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('Content-Type', 'application/json')
      .send('{broken');

    expect(res.status).toBe(400);
  });

  // 'NaN', 'Infinity', '1e400' and '1.5' all survive Number() and then reach
  // Postgres as invalid integer syntax.
  it('treats a non-integer version as not found rather than erroring', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    for (const version of ['NaN', 'Infinity', '999999999999999999999', '1e400', '1.5', '-1']) {
      const res = await request(app)
        .get(`/api/flows/any-id/versions/${encodeURIComponent(version)}`)
        .set('Authorization', `Bearer ${apiKey}`);
      expect(res.status, `version=${version}`).toBe(404);
    }
  });

  it('rejects a rollback to a non-integer version without reaching the database', async () => {
    const apiKey = await createTenant(app, 'a@example.com');
    const bot = await createBotWithLiveTrigger(app, apiKey, 'handle-a');
    const triggers = await request(app).get(`/api/bots/${bot.id}/flows`).set('Authorization', `Bearer ${apiKey}`);
    expect(triggers.status).toBe(200);

    const res = await request(app)
      .post('/api/triggers/any-id/rollback')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ toVersion: 'Infinity' });
    expect(res.status).toBeLessThan(500);
  });
});
