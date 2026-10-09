import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, type Db } from '../src/db';
import { createApp } from '../src/api';
import { chooseNextStep, type HomeState, type UnansweredQuestion } from '../src/home';
import type { ContentTopic } from '../src/contentTopics';
import { createTestDb, dropTestDb } from './dbTestHelper';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function question(name: string, closesInHours: number): UnansweredQuestion {
  return { subscriberId: `s-${name}`, name, text: 'сколько стоит?', askedAt: hoursFromNow(closesInHours - 24), windowClosesAt: hoursFromNow(closesInHours) };
}

const topic: ContentTopic = {
  id: 't1', title: 'Йога при боли в спине', segment: 'Йога', why: 'спрашивали', quotes: ['болит спина'], clientCount: 7, subscriberCount: 19,
} as ContentTopic;

function state(over: Partial<HomeState> = {}): HomeState {
  return {
    hasBot: true, activeDialogs: 0, unanswered: [], recentMessages: [], jobs: [], topic: null, topicCount: 0, nextPost: null,
    week: { inbound: 0, clients: 0 }, ...over,
  };
}

describe('chooseNextStep', () => {
  it('a question whose window closes within hours comes before everything', () => {
    const { step, more } = chooseNextStep(
      state({ unanswered: [question('Айгерим', 3)], topic, jobs: [{ id: 'j', title: 'Ролик', status: 'awaiting_review', progress: 40 }] }),
      NOW
    );
    expect(step).toMatchObject({ kind: 'reply', question: { name: 'Айгерим' } });
    expect(more.map((s) => s.kind)).toEqual(['review_captions', 'film_topic']);
  });

  it('picks the question that closes soonest, and counts the rest', () => {
    const { step } = chooseNextStep(state({ unanswered: [question('Данияр', 5), question('Айгерим', 2)] }), NOW);
    expect(step).toMatchObject({ kind: 'reply', question: { name: 'Айгерим' }, others: 1 });
  });

  it('captions waiting for review come before a topic', () => {
    const { step } = chooseNextStep(state({ topic, jobs: [{ id: 'j', title: 'Ролик', status: 'awaiting_review', progress: 40 }] }), NOW);
    expect(step.kind).toBe('review_captions');
  });

  it('a topic comes before a question that still has most of its day', () => {
    const { step, more } = chooseNextStep(state({ topic, unanswered: [question('Ерлан', 20)] }), NOW);
    expect(step.kind).toBe('film_topic');
    expect(more.map((s) => s.kind)).toEqual(['reply']);
  });

  it('ignores a question whose window has already closed', () => {
    const { step } = chooseNextStep(state({ unanswered: [question('Мария', -1)] }), NOW);
    expect(step.kind).toBe('make_video');
  });

  it('with nothing pending, suggests the next video', () => {
    expect(chooseNextStep(state(), NOW)).toEqual({ step: { kind: 'make_video' }, more: [] });
  });
});

describe('GET /api/home', () => {
  let db: Db;
  let app: Express;

  beforeEach(async () => {
    db = await createTestDb();
    app = createApp(db);
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenant(email: string) {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    const id = res.body.tenant.id as string;
    await exec(db, `INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES (?, ?, 'Bot', ?)`, `bot-${id}`, id, `ig-${id}`);
    return { apiKey: res.body.apiKey as string, id };
  }

  let seq = 0;
  async function said(tenantId: string, name: string, ...turns: Array<['in' | 'out', string, number]>) {
    const sub = `sub-${++seq}`;
    await exec(db, `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, display_name) VALUES (?, ?, ?, ?, ?)`, sub, tenantId, `bot-${tenantId}`, sub, name);
    for (const [direction, text, minutesAgo] of turns) {
      await exec(
        db,
        `INSERT INTO messages (id, tenant_id, bot_id, subscriber_id, direction, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        `m-${++seq}`, tenantId, `bot-${tenantId}`, sub, direction, text, new Date(Date.now() - minutesAgo * 60_000).toISOString()
      );
    }
  }

  it('lists a question nobody answered, not one the bot already did', async () => {
    const t = await tenant('home@example.com');
    await said(t.id, 'Айгерим', ['in', 'Можно в рассрочку?', 30]);
    await said(t.id, 'Данияр', ['in', 'план', 40], ['out', 'Отправлю чек-лист', 39]);
    await said(t.id, 'Старый', ['in', 'есть скидка?', 60 * 30]); // window long closed

    const res = await request(app).get('/api/home').set('Authorization', `Bearer ${t.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.state.unanswered.map((q: UnansweredQuestion) => q.name)).toEqual(['Айгерим']);
    expect(res.body.state.recentMessages[0]).toMatchObject({ name: 'Айгерим', text: 'Можно в рассрочку?' });
    expect(res.body.state.week.inbound).toBe(3); // the closed-window one is still this week
    expect(res.body.step.kind).toBe('reply');
  });

  it('shows one tenant nothing of another', async () => {
    const a = await tenant('home-a@example.com');
    const b = await tenant('home-b@example.com');
    await said(a.id, 'Айгерим', ['in', 'Можно в рассрочку?', 5]);

    const res = await request(app).get('/api/home').set('Authorization', `Bearer ${b.apiKey}`);

    expect(res.body.state).toMatchObject({ unanswered: [], recentMessages: [], activeDialogs: 0, week: { inbound: 0, clients: 0 } });
    expect(res.body.step).toEqual({ kind: 'make_video' });
  });
});
