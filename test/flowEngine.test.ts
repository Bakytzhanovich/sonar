import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { exec, queryOne, queryAll, type Db } from '../src/db';
import { runFlow } from '../src/flowEngine';
import type { FlowDefinition } from '../src/types';
import { createTestDb, dropTestDb } from './dbTestHelper';

const TENANT_ID = 't1';
const BOT_ID = 'bot-1';
const FLOW_ID = 'flow-1';
const TRIGGER_ID = 'trigger-1';

async function seed(db: Db, definition: FlowDefinition, fallbackChannel?: 'comment_reply') {
  if (fallbackChannel) {
    const msgNode = definition.nodes.find((n) => n.type === 'send_message');
    if (msgNode && msgNode.type === 'send_message') msgNode.data.fallbackChannel = fallbackChannel;
  }

  await exec(db, `INSERT INTO tenants (id, name, email) VALUES (?, 'Tenant', 't@example.com')`, TENANT_ID);
  await exec(db, `INSERT INTO bots (id, tenant_id, name, external_account_id) VALUES (?, ?, 'Bot', 'ig-1')`, BOT_ID, TENANT_ID);
  await exec(
    db,
    `INSERT INTO flows (id, bot_id, version, definition, status) VALUES (?, ?, 1, ?, 'published')`,
    FLOW_ID,
    BOT_ID,
    JSON.stringify(definition)
  );
  await exec(
    db,
    `INSERT INTO triggers (id, bot_id, flow_id, flow_version, keyword, match_type) VALUES (?, ?, ?, 1, 'цена', 'contains')`,
    TRIGGER_ID,
    BOT_ID,
    FLOW_ID
  );
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
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    if (db) await dropTestDb(db);
  });

  it('returns no_trigger_match when nothing matches', async () => {
    await seed(db, basicFlowDefinition());
    const outcome = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'привет' });
    expect(outcome.status).toBe('no_trigger_match');
  });

  it('still creates the subscriber and logs the inbound message even when nothing matches (CRM needs the whole conversation, not just successful triggers)', async () => {
    await seed(db, basicFlowDefinition());
    await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'привет, никакого триггера тут нет' });

    const subscriber = await queryOne<{ lead_status: string }>(db, 'SELECT * FROM subscribers WHERE external_user_id = ?', 'u1');
    expect(subscriber).toBeDefined();
    expect(subscriber!.lead_status).toBe('new');

    const messages = await queryAll(
      db,
      'SELECT direction, content FROM messages WHERE subscriber_id = (SELECT id FROM subscribers WHERE external_user_id = ?)',
      'u1'
    );
    expect(messages).toEqual([{ direction: 'in', content: 'привет, никакого триггера тут нет' }]);
  });

  it('test mode does not create a subscriber even on no_trigger_match', async () => {
    await seed(db, basicFlowDefinition());
    await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'test-only', messageText: 'случайный текст', isTest: true });

    const count = await queryOne<{ n: number }>(db, 'SELECT COUNT(*) as n FROM subscribers');
    expect(count!.n).toBe(0);
  });

  it('logs both the inbound trigger message and the outbound reply to the conversation timeline', async () => {
    await seed(db, basicFlowDefinition());
    const outcome = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'какая цена?' });
    if (outcome.status !== 'completed') throw new Error('unreachable');

    const messages = await queryAll(
      db,
      'SELECT direction, content FROM messages WHERE subscriber_id = (SELECT id FROM subscribers WHERE external_user_id = ?) ORDER BY created_at',
      'u1'
    );

    expect(messages).toEqual([
      { direction: 'in', content: 'какая цена?' },
      { direction: 'out', content: 'Вот цена: 10000 тг' },
    ]);
  });

  it('sends a DM to a brand-new subscriber and records the run', async () => {
    await seed(db, basicFlowDefinition());
    const outcome = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?' });

    expect(outcome).toMatchObject({ status: 'completed', sentMessages: [{ channel: 'dm', content: 'Вот цена: 10000 тг' }] });
    if (outcome.status !== 'completed') throw new Error('unreachable');

    const run = await queryOne<{ status: string }>(db, 'SELECT status FROM flow_runs WHERE id = ?', outcome.flowRunId);
    expect(run!.status).toBe('completed');

    const messages = await queryAll(db, 'SELECT channel, content FROM mock_sent_messages WHERE flow_run_id = ?', outcome.flowRunId);
    expect(messages).toHaveLength(1);
  });

  it('does not run the same trigger for the same subscriber twice in one day', async () => {
    await seed(db, basicFlowDefinition());
    const input = { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?' };

    const first = await runFlow(db, input);
    const second = await runFlow(db, input);

    expect(first.status).toBe('completed');
    expect(second.status).toBe('duplicate_today');

    const runCount = await queryOne<{ n: number }>(db, 'SELECT COUNT(*) as n FROM flow_runs');
    expect(runCount!.n).toBe(1);
  });

  it('allows the same trigger again on a later day', async () => {
    await seed(db, basicFlowDefinition());
    const day1 = new Date('2026-08-20T10:00:00.000Z');
    const day2 = new Date('2026-08-21T10:00:00.000Z');

    const first = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now: day1 });
    const second = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now: day2 });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
  });

  it('fails outside the 24h DM window when no fallback channel is configured', async () => {
    await seed(db, basicFlowDefinition());
    const now = new Date('2026-08-20T12:00:00.000Z');
    const staleLastInteraction = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();

    await exec(
      db,
      `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at)
       VALUES ('sub-1', ?, ?, 'u1', ?, ?)`,
      TENANT_ID,
      BOT_ID,
      staleLastInteraction,
      staleLastInteraction
    );

    const outcome = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now });

    expect(outcome).toMatchObject({ status: 'failed', failureReason: 'outside_24h_window_no_fallback_configured' });
    if (outcome.status !== 'failed') throw new Error('unreachable');

    const run = await queryOne<{ status: string; failure_reason: string }>(
      db,
      'SELECT status, failure_reason FROM flow_runs WHERE id = ?',
      outcome.flowRunId
    );
    expect(run!.status).toBe('failed');
    expect(run!.failure_reason).toBe('outside_24h_window_no_fallback_configured');
  });

  it('uses the fallback channel instead of failing when one is configured', async () => {
    await seed(db, basicFlowDefinition(), 'comment_reply');
    const now = new Date('2026-08-20T12:00:00.000Z');
    const staleLastInteraction = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();

    await exec(
      db,
      `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at)
       VALUES ('sub-1', ?, ?, 'u1', ?, ?)`,
      TENANT_ID,
      BOT_ID,
      staleLastInteraction,
      staleLastInteraction
    );

    const outcome = await runFlow(db, { tenantId: TENANT_ID, botId: BOT_ID, externalUserId: 'u1', messageText: 'цена?', now });

    expect(outcome).toMatchObject({ status: 'completed', sentMessages: [{ channel: 'comment_fallback' }] });

    const subscriber = await queryOne<{ last_interacted_at: string }>(db, 'SELECT last_interacted_at FROM subscribers WHERE id = ?', 'sub-1');
    // comment_fallback must NOT open/refresh the DM window
    expect(subscriber!.last_interacted_at).toBe(staleLastInteraction);
  });

  it('test mode evaluates the flow but writes nothing to the database', async () => {
    await seed(db, basicFlowDefinition());
    const outcome = await runFlow(db, {
      tenantId: TENANT_ID,
      botId: BOT_ID,
      externalUserId: 'test-user',
      messageText: 'цена?',
      isTest: true,
    });

    expect(outcome).toMatchObject({ status: 'completed', sentMessages: [{ channel: 'dm' }] });

    const counts = {
      subscribers: (await queryOne<{ n: number }>(db, 'SELECT COUNT(*) as n FROM subscribers'))!.n,
      flowRuns: (await queryOne<{ n: number }>(db, 'SELECT COUNT(*) as n FROM flow_runs'))!.n,
      messages: (await queryOne<{ n: number }>(db, 'SELECT COUNT(*) as n FROM mock_sent_messages'))!.n,
    };
    expect(counts).toEqual({ subscribers: 0, flowRuns: 0, messages: 0 });
  });
});
