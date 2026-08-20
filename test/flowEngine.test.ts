import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDb } from '../src/db';
import { runFlow } from '../src/flowEngine';
import type { FlowDefinition } from '../src/types';

const TENANT_ID = 't1';
const BOT_ID = 'bot-1';
const FLOW_ID = 'flow-1';
const TRIGGER_ID = 'trigger-1';

function seed(db: Database.Database, definition: FlowDefinition, fallbackChannel?: 'comment_reply') {
  if (fallbackChannel) {
    const msgNode = definition.nodes.find((n) => n.type === 'send_message');
    if (msgNode && msgNode.type === 'send_message') msgNode.data.fallbackChannel = fallbackChannel;
  }

  db.prepare(`INSERT INTO tenants (id, name, email) VALUES (?, 'Tenant', 't@example.com')`).run(TENANT_ID);
  db.prepare(`INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES (?, ?, 'Bot', 'ig-1')`).run(BOT_ID, TENANT_ID);
  db.prepare(`INSERT INTO flows (id, bot_id, version, definition, status) VALUES (?, ?, 1, ?, 'published')`).run(
    FLOW_ID,
    BOT_ID,
    JSON.stringify(definition)
  );
  db.prepare(
    `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword, match_type) VALUES (?, ?, ?, 1, 'цена', 'contains')`
  ).run(TRIGGER_ID, BOT_ID, FLOW_ID);
}

function basicFlowDefinition(): FlowDefinition {
  return {
    nodes: [
      { id: 'trig', type: 'trigger', position: { x: 0, y: 0 }, data: { keyword: 'цена', matchType: 'contains' } },
      { id: 'msg1', type: 'send_message', position: { x: 0, y: 100 }, data: { text: 'Вот цена: 10000 тг' } },
    ],
    edges: [{ id: 'e1', source: 'trig', target: 'msg1' }],
  };
}

describe('runFlow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb({ filePath: ':memory:' });
  });

  it('returns no_trigger_match when nothing matches', () => {
    seed(db, basicFlowDefinition());
    const outcome = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'привет' });
    expect(outcome.status).toBe('no_trigger_match');
  });

  it('still creates the subscriber and logs the inbound message even when nothing matches (CRM needs the whole conversation, not just successful triggers)', () => {
    seed(db, basicFlowDefinition());
    runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'привет, никакого триггера тут нет' });

    const subscriber = db.prepare('SELECT * FROM subscribers WHERE external_user_id = ?').get('u1') as { lead_status: string };
    expect(subscriber).toBeDefined();
    expect(subscriber.lead_status).toBe('new');

    const messages = db.prepare('SELECT direction, content FROM messages WHERE subscriber_id = (SELECT id FROM subscribers WHERE external_user_id = ?)').all('u1');
    expect(messages).toEqual([{ direction: 'in', content: 'привет, никакого триггера тут нет' }]);
  });

  it('test mode does not create a subscriber even on no_trigger_match', () => {
    seed(db, basicFlowDefinition());
    runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'test-only', messageText: 'случайный текст', isTest: true });

    const count = db.prepare('SELECT COUNT(*) as n FROM subscribers').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('logs both the inbound trigger message and the outbound reply to the conversation timeline', () => {
    seed(db, basicFlowDefinition());
    const outcome = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'какая цена?' });
    if (outcome.status !== 'completed') throw new Error('unreachable');

    const messages = db
      .prepare(
        'SELECT direction, content FROM messages WHERE subscriber_id = (SELECT id FROM subscribers WHERE external_user_id = ?) ORDER BY created_at'
      )
      .all('u1');

    expect(messages).toEqual([
      { direction: 'in', content: 'какая цена?' },
      { direction: 'out', content: 'Вот цена: 10000 тг' },
    ]);
  });

  it('sends a DM to a brand-new subscriber and records the run', () => {
    seed(db, basicFlowDefinition());
    const outcome = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?' });

    expect(outcome).toMatchObject({ status: 'completed', sentMessages: [{ channel: 'dm', content: 'Вот цена: 10000 тг' }] });
    if (outcome.status !== 'completed') throw new Error('unreachable');

    const run = db.prepare('SELECT status FROM flow_runs WHERE id = ?').get(outcome.flowRunId) as { status: string };
    expect(run.status).toBe('completed');

    const messages = db.prepare('SELECT channel, content FROM mock_sent_messages WHERE flow_run_id = ?').all(outcome.flowRunId);
    expect(messages).toHaveLength(1);
  });

  it('does not run the same trigger for the same subscriber twice in one day', () => {
    seed(db, basicFlowDefinition());
    const input = { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?' };

    const first = runFlow(db, input);
    const second = runFlow(db, input);

    expect(first.status).toBe('completed');
    expect(second.status).toBe('duplicate_today');

    const runCount = db.prepare('SELECT COUNT(*) as n FROM flow_runs').get() as { n: number };
    expect(runCount.n).toBe(1);
  });

  it('allows the same trigger again on a later day', () => {
    seed(db, basicFlowDefinition());
    const day1 = new Date('2026-08-20T10:00:00.000Z');
    const day2 = new Date('2026-08-21T10:00:00.000Z');

    const first = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now: day1 });
    const second = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now: day2 });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
  });

  it('fails outside the 24h DM window when no fallback channel is configured', () => {
    seed(db, basicFlowDefinition());
    const now = new Date('2026-08-20T12:00:00.000Z');
    const staleLastInteraction = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at)
       VALUES ('sub-1', ?, ?, 'u1', ?, ?)`
    ).run(TENANT_ID, BOT_ID, staleLastInteraction, staleLastInteraction);

    const outcome = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now });

    expect(outcome).toMatchObject({ status: 'failed', failureReason: 'outside_24h_window_no_fallback_configured' });
    if (outcome.status !== 'failed') throw new Error('unreachable');

    const run = db.prepare('SELECT status, failure_reason FROM flow_runs WHERE id = ?').get(outcome.flowRunId) as {
      status: string;
      failure_reason: string;
    };
    expect(run.status).toBe('failed');
    expect(run.failure_reason).toBe('outside_24h_window_no_fallback_configured');
  });

  it('uses the fallback channel instead of failing when one is configured', () => {
    seed(db, basicFlowDefinition(), 'comment_reply');
    const now = new Date('2026-08-20T12:00:00.000Z');
    const staleLastInteraction = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at)
       VALUES ('sub-1', ?, ?, 'u1', ?, ?)`
    ).run(TENANT_ID, BOT_ID, staleLastInteraction, staleLastInteraction);

    const outcome = runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now });

    expect(outcome).toMatchObject({ status: 'completed', sentMessages: [{ channel: 'comment_fallback' }] });

    const subscriber = db.prepare('SELECT last_interacted_at FROM subscribers WHERE id = ?').get('sub-1') as {
      last_interacted_at: string;
    };
    // comment_fallback must NOT open/refresh the DM window
    expect(subscriber.last_interacted_at).toBe(staleLastInteraction);
  });

  it('test mode evaluates the flow but writes nothing to the database', () => {
    seed(db, basicFlowDefinition());
    const outcome = runFlow(db, {
      tenantId: TENANT_ID,
      botId: BOT_ID,
      externalUserId: 'test-user',
      messageText: 'цена?',
      isTest: true,
    });

    expect(outcome).toMatchObject({ status: 'completed', sentMessages: [{ channel: 'dm' }] });

    const counts = {
      subscribers: (db.prepare('SELECT COUNT(*) as n FROM subscribers').get() as { n: number }).n,
      flowRuns: (db.prepare('SELECT COUNT(*) as n FROM flow_runs').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) as n FROM mock_sent_messages').get() as { n: number }).n,
    };
    expect(counts).toEqual({ subscribers: 0, flowRuns: 0, messages: 0 });
  });
});
