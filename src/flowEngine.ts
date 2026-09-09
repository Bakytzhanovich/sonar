import { randomUUID } from 'node:crypto';
import { exec, isUniqueViolation, queryOne, type Db } from './db';
import { getActiveTriggersForBot, hasRunToday, matchTrigger } from './triggerMatcher';
import type {
  Flow,
  FlowDefinition,
  FlowRunFailureReason,
  MessageChannel,
  MessageDirection,
  NodeId,
  SendMessageNode,
  Subscriber,
} from './types';

const DM_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunFlowInput {
  tenantId: string;
  botId: string;
  externalUserId: string;
  messageText: string;
  /** Test-mode runs never touch subscribers/flow_runs/mock_sent_messages. */
  isTest?: boolean;
  /** Injectable clock, mainly for tests exercising the 24h window. */
  now?: Date;
}

export interface SentMessage {
  channel: MessageChannel;
  content: string;
}

export type RunFlowOutcome =
  | { status: 'no_trigger_match' }
  | { status: 'duplicate_today'; triggerId: string }
  | { status: 'failed'; triggerId: string; flowRunId?: string; failureReason: FlowRunFailureReason }
  | { status: 'completed'; triggerId: string; flowRunId?: string; sentMessages: SentMessage[] };

export async function runFlow(db: Db, input: RunFlowInput): Promise<RunFlowOutcome> {
  const now = input.now ?? new Date();
  const isTest = input.isTest ?? false;

  // Subscriber lookup/creation and the inbound-message log happen before
  // trigger matching, on purpose: a CRM contact card (Module 2) has to
  // exist for anyone who ever messaged the bot, not just people whose
  // message happened to match a keyword. Previously a non-matching
  // message touched the database at all — that made it invisible to CRM.
  const subscriber = await findOrCreateSubscriber(db, input.tenantId, input.botId, input.externalUserId, now, isTest);
  if (!isTest) {
    await logMessage(db, { tenantId: input.tenantId, botId: input.botId, subscriberId: subscriber.id, direction: 'in', content: input.messageText, now });
  }

  const triggers = await getActiveTriggersForBot(db, input.botId);
  const trigger = matchTrigger(triggers, input.messageText);
  if (!trigger) return { status: 'no_trigger_match' };

  const runDate = toCalendarDay(now);
  if (!isTest && (await hasRunToday(db, trigger.id, subscriber.id, runDate))) {
    return { status: 'duplicate_today', triggerId: trigger.id };
  }

  const flow = await loadFlow(db, trigger.flow_id, trigger.flow_version);
  if (!flow) {
    return { status: 'failed', triggerId: trigger.id, failureReason: 'flow_not_found' };
  }

  const flowRunId = isTest ? undefined : randomUUID();
  if (flowRunId) {
    const inserted = await tryInsertFlowRun(db, {
      id: flowRunId,
      tenantId: input.tenantId,
      botId: input.botId,
      triggerId: trigger.id,
      subscriberId: subscriber.id,
      flowId: trigger.flow_id,
      flowVersion: trigger.flow_version,
      runDate,
    });
    if (!inserted) {
      // Lost the race to a concurrent delivery of the same event — the
      // pre-check above missed it, but the UNIQUE constraint didn't.
      return { status: 'duplicate_today', triggerId: trigger.id };
    }
  }

  const messageNodes = collectMessageNodes(flow.definition);
  const sentMessages: SentMessage[] = [];

  for (const node of messageNodes) {
    const withinDmWindow = now.getTime() - new Date(subscriber.last_interacted_at).getTime() <= DM_WINDOW_MS;

    let channel: MessageChannel;
    if (withinDmWindow) {
      channel = 'dm';
    } else if (node.data.fallbackChannel === 'comment_reply') {
      channel = 'comment_fallback';
    } else {
      await failFlowRun(db, flowRunId, now, 'outside_24h_window_no_fallback_configured');
      return { status: 'failed', triggerId: trigger.id, flowRunId, failureReason: 'outside_24h_window_no_fallback_configured' };
    }

    sentMessages.push({ channel, content: node.data.text });

    if (flowRunId) {
      await exec(
        db,
        `INSERT INTO mock_sent_messages (id, flow_run_id, subscriber_id, channel, content) VALUES (?, ?, ?, ?, ?)`,
        randomUUID(),
        flowRunId,
        subscriber.id,
        channel,
        node.data.text
      );
      await logMessage(db, { tenantId: input.tenantId, botId: input.botId, subscriberId: subscriber.id, direction: 'out', content: node.data.text, now });
    }

    // Only a DM send opens/refreshes the 24h window — this trigger is
    // conceptually a comment ("keyword under a post"), not a DM, so the
    // inbound event itself must NOT be treated as opening the window.
    // Otherwise the check could never fail: any inbound message would
    // always look like a fresh interaction happening "now".
    if (channel === 'dm') {
      subscriber.last_interacted_at = now.toISOString();
      if (!isTest) {
        await exec(db, `UPDATE subscribers SET last_interacted_at = ? WHERE id = ?`, now.toISOString(), subscriber.id);
      }
    }
  }

  if (flowRunId) {
    await exec(db, `UPDATE flow_runs SET status = 'completed', completed_at = ? WHERE id = ?`, now.toISOString(), flowRunId);
  }

  return { status: 'completed', triggerId: trigger.id, flowRunId, sentMessages };
}

async function findOrCreateSubscriber(
  db: Db,
  tenantId: string,
  botId: string,
  externalUserId: string,
  now: Date,
  isTest: boolean
): Promise<Subscriber> {
  const existing = await queryOne<Subscriber>(
    db,
    `SELECT id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at, lead_status
     FROM subscribers WHERE bot_id = ? AND external_user_id = ?`,
    botId,
    externalUserId
  );

  if (existing) return existing;

  const fresh: Subscriber = {
    id: randomUUID(),
    tenant_id: tenantId,
    bot_id: botId,
    external_user_id: externalUserId,
    first_seen_at: now.toISOString(),
    last_interacted_at: now.toISOString(),
    lead_status: 'new',
  };

  // Test mode must not create real subscriber rows either — a synthetic
  // in-memory subscriber is enough to evaluate the flow. Real subscriber
  // counts otherwise pick up phantom entries from someone hitting "test".
  if (!isTest) {
    try {
      await exec(
        db,
        `INSERT INTO subscribers (id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        fresh.id,
        fresh.tenant_id,
        fresh.bot_id,
        fresh.external_user_id,
        fresh.first_seen_at,
        fresh.last_interacted_at
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost the race to a concurrent delivery for the same
      // (bot_id, external_user_id) — the SELECT above missed it because
      // every await point here is a place another request can interleave
      // now that this runs against Postgres instead of synchronous SQLite.
      // The winner's row is authoritative (its last_interacted_at is real,
      // ours is a synthetic guess), so fetch and use that instead of
      // throwing the message away.
      const winner = await queryOne<Subscriber>(
        db,
        `SELECT id, tenant_id, bot_id, external_user_id, first_seen_at, last_interacted_at, lead_status
         FROM subscribers WHERE bot_id = ? AND external_user_id = ?`,
        botId,
        externalUserId
      );
      if (winner) return winner;
      throw err;
    }
  }

  return fresh;
}

interface LogMessageArgs {
  tenantId: string;
  botId: string;
  subscriberId: string;
  direction: MessageDirection;
  content: string;
  now: Date;
}

// Module 2's conversation timeline. Deliberately separate from
// mock_sent_messages (Module 1's per-flow-run execution record) — this
// table is subscriber-centric and includes inbound content, which
// mock_sent_messages never has.
async function logMessage(db: Db, args: LogMessageArgs): Promise<void> {
  await exec(
    db,
    `INSERT INTO messages (id, tenant_id, bot_id, subscriber_id, direction, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    args.tenantId,
    args.botId,
    args.subscriberId,
    args.direction,
    args.content,
    args.now.toISOString()
  );
}

async function loadFlow(db: Db, flowId: string, flowVersion: number): Promise<Flow | undefined> {
  return queryOne<Flow>(
    db,
    `SELECT id, bot_id, version, definition, status, created_at FROM flows WHERE id = ? AND version = ?`,
    flowId,
    flowVersion
  );
}

interface InsertFlowRunArgs {
  id: string;
  tenantId: string;
  botId: string;
  triggerId: string;
  subscriberId: string;
  flowId: string;
  flowVersion: number;
  runDate: string;
}

// Returns false (instead of throwing) specifically on the UNIQUE(trigger_id,
// subscriber_id, run_date) violation — that specific failure is an expected
// outcome (a race with another delivery), not an error condition.
async function tryInsertFlowRun(db: Db, args: InsertFlowRunArgs): Promise<boolean> {
  try {
    await exec(
      db,
      `INSERT INTO flow_runs (id, tenant_id, bot_id, trigger_id, subscriber_id, flow_id, flow_version, run_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
      args.id,
      args.tenantId,
      args.botId,
      args.triggerId,
      args.subscriberId,
      args.flowId,
      args.flowVersion,
      args.runDate
    );
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

async function failFlowRun(db: Db, flowRunId: string | undefined, now: Date, reason: FlowRunFailureReason): Promise<void> {
  if (!flowRunId) return;
  await exec(
    db,
    `UPDATE flow_runs SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ?`,
    reason,
    now.toISOString(),
    flowRunId
  );
}

// Walks the flow graph breadth-first from its trigger node, collecting
// every send_message node reached along the way, in traversal order.
// Exported so api.ts's publish-time validation can check "at least one
// message node is actually reachable" without duplicating the traversal.
export function collectMessageNodes(flow: FlowDefinition): SendMessageNode[] {
  const triggerNode = flow.nodes.find((node) => node.type === 'trigger');
  if (!triggerNode) return [];

  const byId = new Map(flow.nodes.map((node) => [node.id, node] as const));
  const result: SendMessageNode[] = [];
  const visited = new Set<NodeId>([triggerNode.id]);
  let frontier = outgoingTargets(flow, triggerNode.id);

  while (frontier.length > 0) {
    const nextFrontier: NodeId[] = [];
    for (const nodeId of frontier) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = byId.get(nodeId);
      if (node?.type === 'send_message') result.push(node);

      nextFrontier.push(...outgoingTargets(flow, nodeId));
    }
    frontier = nextFrontier;
  }

  return result;
}

function outgoingTargets(flow: FlowDefinition, sourceId: NodeId): NodeId[] {
  return flow.edges.filter((edge) => edge.source === sourceId).map((edge) => edge.target);
}

// UTC calendar day. MVP has no per-subscriber timezone data, so "the same
// day" means the same UTC date for everyone — a documented simplification,
// not an attempt at per-subscriber local-time accuracy.
function toCalendarDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
