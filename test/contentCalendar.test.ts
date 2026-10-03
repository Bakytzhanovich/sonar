import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exec, type Db } from '../src/db';
import { createApp } from '../src/api';
import { addDays, alternateSegments, isDay, spreadTopics, weekOffsets } from '../src/contentCalendar';
import type { ContentTopic } from '../src/contentTopics';
import type { ChatModel } from '../src/reelLlm';
import { createTestDb, dropTestDb } from './dbTestHelper';

const topic = (id: string, segment: string): ContentTopic => ({
  id,
  title: `Тема ${id}`,
  segment,
  why: '',
  quotes: ['q'],
  clientCount: 1,
  subscriberCount: 2,
});

describe('laying topics onto a week', () => {
  it('spreads videos across the week instead of bunching them', () => {
    expect(weekOffsets(3)).toEqual([0, 2, 4]); // Mon, Wed, Fri
    expect(weekOffsets(1)).toEqual([0]);
    expect(weekOffsets(2)).toEqual([0, 3]);
    expect(weekOffsets(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekOffsets(99)).toHaveLength(7);
  });

  it('does not give one audience three videos in a row when there is another to serve', () => {
    const ordered = alternateSegments([topic('1', 'A'), topic('2', 'A'), topic('3', 'A'), topic('4', 'B')]);
    expect(ordered.map((t) => t.segment)).toEqual(['A', 'B', 'A', 'A']);
  });

  it('fills only free days, with topics not already in the calendar', () => {
    const placed = spreadTopics(
      [topic('1', 'A'), topic('2', 'B'), topic('3', 'A')],
      '2026-10-05',
      3,
      new Set(['2026-10-07']),
      { topicIds: new Set(['1']), titles: new Set() }
    );
    expect(placed.map((p) => [p.day, p.topic.id])).toEqual([
      ['2026-10-05', '2'],
      ['2026-10-09', '3'],
    ]);
  });

  it('never plans a day that has already gone', () => {
    const placed = spreadTopics([topic('1', 'A'), topic('2', 'B')], '2026-10-05', 3, new Set(), { topicIds: new Set(), titles: new Set() }, '2026-10-08');
    expect(placed.map((p) => p.day)).toEqual(['2026-10-09']);
  });

  it('knows a real date from a malformed one, and steps across a month', () => {
    expect(isDay('2026-10-05')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('05.10.2026')).toBe(false);
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('content calendar API', () => {
  let db: Db;
  let app: Express;
  let chat: ChatModel;
  const MONDAY = '2026-10-05';

  beforeEach(async () => {
    db = await createTestDb();
    chat = async () => JSON.stringify({ script: 'Хук: сценарий' });
    app = createApp(db, { reelChat: (s, u) => chat(s, u), tokenKeyring: null, instagram: null });
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenantWithPlan(email: string, topics: ContentTopic[]) {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    const id = res.body.tenant.id as string;
    await exec(
      db,
      `INSERT INTO content_plans (tenant_id, topics, source_hash, generated_at) VALUES (?, ?::jsonb, 'h', now())`,
      id,
      JSON.stringify(topics)
    );
    return { auth: `Bearer ${res.body.apiKey}`, id };
  }

  const week = (auth: string, from = MONDAY) =>
    request(app).get(`/api/content-calendar?from=${from}&to=${addDays(from, 6)}`).set('Authorization', auth);

  it('lays the plan onto Monday, Wednesday and Friday, and does not double up when asked again', async () => {
    const t = await tenantWithPlan('cal@example.com', [topic('1', 'A'), topic('2', 'A'), topic('3', 'B'), topic('4', 'B')]);
    const first = await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: MONDAY, perWeek: 3 });

    expect(first.status).toBe(200);
    // The day comes back exactly as it went in — no time-zone drift.
    expect(first.body.entries.map((e: { day: string; segment: string }) => [e.day, e.segment])).toEqual([
      ['2026-10-05', 'A'],
      ['2026-10-07', 'B'],
      ['2026-10-09', 'A'],
    ]);

    await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: MONDAY, perWeek: 3 });
    expect((await week(t.auth)).body.entries).toHaveLength(3);

    // The next week gets what is left, not the same topics again.
    const next = await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: '2026-10-12', perWeek: 3 });
    expect(next.body.entries.map((e: { topic_id: string }) => e.topic_id)).toEqual(['4']);
  });

  it('moves and removes an entry', async () => {
    const t = await tenantWithPlan('move@example.com', [topic('1', 'A')]);
    const [entry] = (await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: MONDAY })).body.entries;

    await request(app).patch(`/api/content-calendar/${entry.id}`).set('Authorization', t.auth).send({ day: '2026-10-08' });
    expect((await week(t.auth)).body.entries[0].day).toBe('2026-10-08');

    expect((await request(app).delete(`/api/content-calendar/${entry.id}`).set('Authorization', t.auth)).status).toBe(204);
    expect((await week(t.auth)).body.entries).toHaveLength(0);
  });

  it('keeps a laid-out week when the plan behind it is rebuilt', async () => {
    const t = await tenantWithPlan('keep@example.com', [topic('1', 'A')]);
    await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: MONDAY });
    await exec(db, `UPDATE content_plans SET topics = ?::jsonb WHERE tenant_id = ?`, JSON.stringify([topic('new', 'A')]), t.id);

    const entries = (await week(t.auth)).body.entries;
    expect(entries).toEqual([expect.objectContaining({ title: 'Тема 1', topic_id: '1' })]);
    // A script can still be written for it, from its own title.
    const script = await request(app).post(`/api/content-calendar/${entries[0].id}/script`).set('Authorization', t.auth);
    expect(script.body.script).toContain('Хук');
    expect((await week(t.auth)).body.entries[0].script).toContain('Хук');
  });

  it('shows a script written on the topic card in the calendar too', async () => {
    const t = await tenantWithPlan('sync@example.com', [topic('1', 'A')]);
    await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: MONDAY });
    await request(app).post('/api/content-plan/topics/1/script').set('Authorization', t.auth);
    expect((await week(t.auth)).body.entries[0].script).toContain('Хук');
  });

  it('refuses a malformed or runaway date range', async () => {
    const t = await tenantWithPlan('range@example.com', []);
    expect((await request(app).get('/api/content-calendar?from=2026-10-05&to=bad').set('Authorization', t.auth)).status).toBe(400);
    expect((await request(app).get('/api/content-calendar?from=2026-01-01&to=2026-12-31').set('Authorization', t.auth)).status).toBe(400);
    expect((await request(app).post('/api/content-calendar/auto').set('Authorization', t.auth).send({ weekStart: MONDAY })).status).toBe(409);
  });

  it('keeps one workspace out of another\'s calendar', async () => {
    const a = await tenantWithPlan('a-cal@example.com', [topic('1', 'A')]);
    const b = await tenantWithPlan('b-cal@example.com', [topic('2', 'B')]);
    const [entry] = (await request(app).post('/api/content-calendar/auto').set('Authorization', a.auth).send({ weekStart: MONDAY })).body.entries;

    expect((await week(b.auth)).body.entries).toHaveLength(0);
    expect((await request(app).patch(`/api/content-calendar/${entry.id}`).set('Authorization', b.auth).send({ day: MONDAY })).status).toBe(404);
    expect((await request(app).delete(`/api/content-calendar/${entry.id}`).set('Authorization', b.auth)).status).toBe(404);
    expect((await request(app).post(`/api/content-calendar/${entry.id}/script`).set('Authorization', b.auth)).status).toBe(404);
  });
});
