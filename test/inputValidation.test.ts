import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/db';
import { createApp } from '../src/api';
import { createTestDb, dropTestDb } from './dbTestHelper';

// Found by sending malformed input to every route: each of these answered
// 500 — the server crashing on the caller's mistake — instead of 400.

describe('malformed input is a bad request, not a server fault', () => {
  let db: Db;
  let app: Express;
  let auth: string;
  let botId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
    const t = await request(app).post('/api/tenants').send({ name: 'B', email: 'v@example.com' });
    auth = `Bearer ${t.body.apiKey}`;
    botId = (await request(app).post('/api/bots').set('Authorization', auth).send({ name: 'bot', externalAccountId: 'acc' })).body.bot.id;
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('refuses a date filter that is not a date', async () => {
    const res = await request(app).get('/api/scheduled-posts?from=notadate').set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('refuses a trigger whose fields have the wrong types', async () => {
    for (const body of [
      { keyword: {}, flowId: 'f', flowVersion: 1 },
      { keyword: 'цена', flowId: 'f', flowVersion: 'z' },
      { keyword: 'цена', flowId: 1, flowVersion: 1 },
      { keyword: 'цена', flowId: 'f', flowVersion: 1, matchType: 'regex' },
    ]) {
      expect((await request(app).post(`/api/bots/${botId}/triggers`).set('Authorization', auth).send(body)).status).toBe(400);
    }
  });

  it('refuses a test message that is not text', async () => {
    const res = await request(app).post(`/api/bots/${botId}/test`).set('Authorization', auth).send({ externalUserId: 'u', messageText: 7 });
    expect(res.status).toBe(400);
  });

  it('treats a value the database cannot read as the caller\'s error', async () => {
    // A route that does not check the version's type lets Postgres reject it;
    // that rejection is now a 400 too, not a 500.
    const res = await request(app).post('/api/flows/nope/versions/1.5/publish').set('Authorization', auth).send({});
    expect(res.status).toBeLessThan(500);
  });
});

describe('client address check', () => {
  it('tells a caller the address the server sees for them, signed in or not', async () => {
    const db = await createTestDb();
    try {
      const res = await request(createApp(db)).get('/api/auth/client-ip');
      expect(res.status).toBe(200);
      expect(typeof res.body.ip).toBe('string');
    } finally {
      await dropTestDb(db);
    }
  });
});
