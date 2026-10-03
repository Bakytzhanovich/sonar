import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { maskPersonalData, parseTopics } from '../src/contentTopics';
import type { ChatModel } from '../src/reelLlm';
import { createTestDb, dropTestDb } from './dbTestHelper';

describe('maskPersonalData', () => {
  it('removes phones, e-mails and handles, and keeps what was asked', () => {
    const text = maskPersonalData('Здравствуйте! Мой номер +7 (701) 234-56-78, почта anna.k@mail.kz, я от @anna_fit. Какой размер брать на рост 165?');
    expect(text).not.toMatch(/701|234|anna/);
    expect(text).toContain('[номер]');
    expect(text).toContain('[почта]');
    expect(text).toContain('[ник]');
    // Short numbers are what people ask about, not who they are.
    expect(text).toContain('рост 165');
  });
});

const SIGNALS = [
  {
    segment: 'Йога',
    subscriberCount: 10,
    clientCount: 4,
    clientMessages: ['Подойдёт ли курс, если болит спина после родов?', 'а можно заниматься утром до работы, если всего 20 минут'],
    otherMessages: ['сколько стоит'],
  },
];

describe('parseTopics', () => {
  const answer = (topics: unknown[]) => JSON.stringify({ topics });

  it('keeps a topic whose quotes are really in buyers\' messages', () => {
    const [topic] = parseTopics(
      answer([{ title: 'Йога при боли в спине после родов', segment: 'йога', why: 'Купившие спрашивали про спину', quotes: ['«болит спина после родов»'] }]),
      SIGNALS
    );
    expect(topic).toMatchObject({ segment: 'Йога', quotes: ['болит спина после родов'], clientCount: 4, subscriberCount: 10 });
  });

  // The model can phrase a topic; it cannot invent the reason for it.
  it('drops a topic whose evidence is made up, or whose segment does not exist', () => {
    const topics = parseTopics(
      answer([
        { title: 'Выдумка', segment: 'Йога', why: 'x', quotes: ['хочу похудеть к лету на десять кило'] },
        { title: 'Чужой сегмент', segment: 'Бег', why: 'x', quotes: ['болит спина после родов'] },
        { title: 'Не купившие', segment: 'Йога', why: 'x', quotes: ['сколько стоит'] },
        { title: 'Утро', segment: 'Йога', why: 'x', quotes: ['заниматься утром до работы'] },
      ]),
      SIGNALS
    );
    expect(topics.map((t) => t.title)).toEqual(['Утро']);
  });

  it('refuses an answer with no grounded topic at all', () => {
    expect(() => parseTopics(answer([{ title: 'x', segment: 'Йога', quotes: ['да'] }]), SIGNALS)).toThrow();
    expect(() => parseTopics('не JSON', SIGNALS)).toThrow();
  });
});

describe('content plan API', () => {
  let db: Db;
  let app: Express;
  let chat: ChatModel;
  let prompts: string[];

  beforeEach(async () => {
    db = await createTestDb();
    prompts = [];
    chat = async (_system, user) => {
      prompts.push(user);
      return JSON.stringify({
        topics: [{ title: 'Йога при боли в спине', segment: 'Йога', why: 'Спрашивали про спину', quotes: ['болит спина после родов'] }],
      });
    };
    app = createApp(db, { reelChat: (s, u) => chat(s, u), tokenKeyring: null, instagram: null });
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenant(email: string) {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    const id = res.body.tenant.id as string;
    await exec(db, `INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES (?, ?, 'Bot', ?)`, `bot-${id}`, id, `ig-${id}`);
    await exec(db, `INSERT INTO tags (id, tenant_id, name) VALUES (?, ?, 'Йога')`, `tag-${id}`, id);
    return { apiKey: res.body.apiKey as string, id };
  }

  let seq = 0;
  async function contact(tenantId: string, status: string, ...said: string[]) {
    const sub = `sub-${++seq}`;
    await exec(db, `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, lead_status) VALUES (?, ?, ?, ?, ?)`, sub, tenantId, `bot-${tenantId}`, sub, status);
    await exec(db, `INSERT INTO subscriber_tags (subscriber_id, tag_id) VALUES (?, ?)`, sub, `tag-${tenantId}`);
    for (const text of said) {
      await exec(
        db,
        `INSERT INTO messages (id, tenant_id, bot_id, subscriber_id, direction, content) VALUES (?, ?, ?, ?, 'in', ?)`,
        `m-${++seq}`, tenantId, `bot-${tenantId}`, sub, text
      );
    }
  }

  async function buyersAsked(tenantId: string) {
    await contact(tenantId, 'client', 'Подойдёт ли курс, если болит спина после родов? Мой номер 87012345678');
    await contact(tenantId, 'client', 'а можно заниматься утром до работы');
    await contact(tenantId, 'client', 'есть ли рассрочка');
    await contact(tenantId, 'new', 'сколько стоит');
  }

  it('says what is missing before there is enough to read', async () => {
    const t = await tenant('empty@example.com');
    await contact(t.id, 'client', 'один вопрос');
    const res = await request(app).get('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    expect(res.body.plan).toBeNull();
    expect(res.body.readiness).toMatchObject({ instagramConnected: false, inboundMessages: 1, clients: 1, clientMessages: 1, ready: false });

    const make = await request(app).post('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    expect(make.status).toBe(409);
    expect(prompts).toHaveLength(0);
  });

  it('makes a plan from buyers\' messages, without sending a phone number to the model', async () => {
    const t = await tenant('plan@example.com');
    await buyersAsked(t.id);
    const res = await request(app).post('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.plan.topics[0]).toMatchObject({ title: 'Йога при боли в спине', segment: 'Йога', clientCount: 3, subscriberCount: 4 });
    expect(prompts[0]).toContain('болит спина после родов');
    expect(prompts[0]).not.toContain('87012345678');
    // Buyers and the rest are told apart: that difference is the whole signal.
    expect(prompts[0]).toMatch(/Сообщения не купивших:\n- сколько стоит/);
  });

  it('keeps the plan, and says when conversations have moved on since', async () => {
    const t = await tenant('stale@example.com');
    await buyersAsked(t.id);
    await request(app).post('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);

    const fresh = await request(app).get('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    expect(fresh.body.plan.stale).toBe(false);
    await contact(t.id, 'client', 'а для беременных подходит?');
    const later = await request(app).get('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    expect(later.body.plan.stale).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it('writes a script for a topic and keeps it on the topic', async () => {
    const t = await tenant('script@example.com');
    await buyersAsked(t.id);
    const made = await request(app).post('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    const topicId = made.body.plan.topics[0].id;

    chat = async () => JSON.stringify({ script: 'Хук: болит спина после родов?' });
    const res = await request(app).post(`/api/content-plan/topics/${topicId}/script`).set('Authorization', `Bearer ${t.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.topic.script).toContain('болит спина');

    const again = await request(app).get('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    expect(again.body.plan.topics[0].script).toContain('болит спина');
  });

  it('says the model is not set up rather than inventing topics', async () => {
    const t = await tenant('nollm@example.com');
    await buyersAsked(t.id);
    chat = async () => { throw new (await import('../src/reelLlm')).ReelAnalysisError('llm_not_configured'); };
    const res = await request(app).post('/api/content-plan').set('Authorization', `Bearer ${t.apiKey}`);
    expect(res.status).toBe(503);
    expect(await queryOne(db, `SELECT tenant_id FROM content_plans WHERE tenant_id = ?`, t.id)).toBeUndefined();
  });

  it('never reads another workspace\'s messages or topics', async () => {
    const a = await tenant('a@example.com');
    const b = await tenant('b@example.com');
    await buyersAsked(a.id);
    const made = await request(app).post('/api/content-plan').set('Authorization', `Bearer ${a.apiKey}`);

    const bPlan = await request(app).get('/api/content-plan').set('Authorization', `Bearer ${b.apiKey}`);
    expect(bPlan.body.plan).toBeNull();
    expect(bPlan.body.readiness.inboundMessages).toBe(0);
    const bScript = await request(app)
      .post(`/api/content-plan/topics/${made.body.plan.topics[0].id}/script`)
      .set('Authorization', `Bearer ${b.apiKey}`);
    expect(bScript.status).toBe(404);
  });
});
