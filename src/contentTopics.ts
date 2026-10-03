import { createHash, randomBytes } from 'node:crypto';
import { exec, queryAll, queryOne, type Db, type Queryable } from './db';
import { parseScript, ReelAnalysisError, type ChatModel } from './reelLlm';

// Module 6 — what to film next, read from what buyers asked.
//
// The segment numbers (computeContentRecommendations) say WHICH audience
// converts. They cannot say what to make for it. This reads the direct
// messages: what the people who bought asked about, against what the people
// who did not asked about, and turns the difference into video topics.
//
// Two rules keep it honest, the same stance as reelLlm.ts:
//
//   1. Every topic carries quotes, and every quote must be found, word for
//      word, in a buyer's message from that segment. A topic whose evidence
//      cannot be found is dropped. The model can phrase a topic; it cannot
//      invent the reason for it.
//   2. Personal data is masked before anything leaves for the model —
//      phone numbers, e-mails, @handles, card-like digit runs (Kazakhstan's
//      personal data law, CLAUDE.md). The quotes shown back are taken from
//      the masked text, so the masking holds on the screen too.
//
// Generated on request and kept, not on every page view: a model call costs
// money and seconds, and the inputs change at the pace of conversations, not
// of page loads.

export interface ContentTopic {
  id: string;
  /** The video, as a working title. */
  title: string;
  /** The CRM tag the topic is for — always one of the workspace's tags. */
  segment: string;
  /** Why this topic: what buyers in the segment asked about. */
  why: string;
  /** Verbatim excerpts of buyers' messages, masked. At least one. */
  quotes: string[];
  clientCount: number;
  subscriberCount: number;
  /** A script for the topic, once someone has asked for one. */
  script?: string;
}

export interface ContentPlan {
  topics: ContentTopic[];
  generatedAt: string;
  /** True when conversations have moved on since the plan was made. */
  stale: boolean;
}

export interface PlanReadiness {
  instagramConnected: boolean;
  inboundMessages: number;
  taggedSubscribers: number;
  clients: number;
  /** Buyers' messages in segments that have a buyer — what the plan reads. */
  clientMessages: number;
  /** Enough to ask for a plan at all. */
  ready: boolean;
}

/** Below this, a "pattern" is one person's question. */
export const MIN_CLIENT_MESSAGES = 3;

// ---- Masking ---------------------------------------------------------------

/**
 * Strips what identifies a person, keeping what they asked.
 *
 * Deliberately blunt: a run of seven or more digits goes whatever it was —
 * a price written without spaces is a small loss, a phone number sent to a
 * model provider is not a small thing.
 */
export function maskPersonalData(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[почта]')
    .replace(/(^|[^\w])@[\w.]{2,}/g, '$1[ник]')
    .replace(/\+?\d[\d\s()-]{5,}\d/g, (run) => (run.replace(/\D/g, '').length >= 7 ? '[номер]' : run))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- What the plan reads ---------------------------------------------------

interface SegmentSignal {
  segment: string;
  subscriberCount: number;
  clientCount: number;
  clientMessages: string[];
  otherMessages: string[];
}

// A budget per segment, so one busy segment cannot crowd the rest out of the
// prompt, and a ceiling per message, so one essay cannot either.
const CLIENT_MESSAGES_PER_SEGMENT = 60;
const OTHER_MESSAGES_PER_SEGMENT = 30;
const MAX_MESSAGE_CHARS = 280;
const MAX_SEGMENTS = 8;

async function collectSignals(db: Db, tenantId: string): Promise<SegmentSignal[]> {
  // Newest first within each segment and side, numbered so the budget can
  // be applied in SQL rather than by fetching every message ever received.
  const rows = await queryAll<{ segment: string; is_client: boolean; content: string }>(
    db,
    `SELECT segment, is_client, content FROM (
       SELECT tags.name AS segment,
              subscribers.lead_status = 'client' AS is_client,
              messages.content,
              ROW_NUMBER() OVER (
                PARTITION BY tags.id, subscribers.lead_status = 'client'
                ORDER BY messages.created_at DESC
              ) AS n
       FROM messages
       JOIN subscribers ON subscribers.id = messages.subscriber_id
       JOIN subscriber_tags ON subscriber_tags.subscriber_id = subscribers.id
       JOIN tags ON tags.id = subscriber_tags.tag_id
       WHERE messages.tenant_id = ? AND messages.direction = 'in'
     ) ranked
     WHERE (is_client AND n <= ?) OR (NOT is_client AND n <= ?)`,
    tenantId,
    CLIENT_MESSAGES_PER_SEGMENT,
    OTHER_MESSAGES_PER_SEGMENT
  );

  const counts = await queryAll<{ segment: string; total: number; clients: number }>(
    db,
    `SELECT tags.name AS segment, COUNT(*)::int AS total,
            SUM(CASE WHEN subscribers.lead_status = 'client' THEN 1 ELSE 0 END)::int AS clients
     FROM subscriber_tags
     JOIN subscribers ON subscribers.id = subscriber_tags.subscriber_id
     JOIN tags ON tags.id = subscriber_tags.tag_id
     WHERE tags.tenant_id = ?
     GROUP BY tags.name`,
    tenantId
  );

  const bySegment = new Map<string, SegmentSignal>();
  for (const c of counts) {
    if (c.clients === 0) continue;
    bySegment.set(c.segment, { segment: c.segment, subscriberCount: c.total, clientCount: c.clients, clientMessages: [], otherMessages: [] });
  }
  for (const row of rows) {
    const signal = bySegment.get(row.segment);
    if (!signal) continue;
    const text = maskPersonalData(row.content).slice(0, MAX_MESSAGE_CHARS);
    if (text.length < 3) continue;
    (row.is_client ? signal.clientMessages : signal.otherMessages).push(text);
  }
  return [...bySegment.values()]
    .filter((s) => s.clientMessages.length > 0)
    .sort((a, b) => b.clientCount / b.subscriberCount - a.clientCount / a.subscriberCount)
    .slice(0, MAX_SEGMENTS);
}

/** Changes whenever a message arrives or a contact's status or tags change —
 *  which is when a plan made earlier may no longer say the right thing. */
async function sourceHash(db: Db, tenantId: string): Promise<string> {
  const row = await queryOne<{ messages: number; last_message: string | null; clients: number; tagged: number }>(
    db,
    `SELECT
       (SELECT COUNT(*)::int FROM messages WHERE tenant_id = ? AND direction = 'in') AS messages,
       (SELECT MAX(created_at)::text FROM messages WHERE tenant_id = ?) AS last_message,
       (SELECT COUNT(*)::int FROM subscribers WHERE tenant_id = ? AND lead_status = 'client') AS clients,
       (SELECT COUNT(*)::int FROM subscriber_tags JOIN tags ON tags.id = subscriber_tags.tag_id WHERE tags.tenant_id = ?) AS tagged`,
    tenantId,
    tenantId,
    tenantId,
    tenantId
  );
  return createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16);
}

export async function planReadiness(db: Db, tenantId: string): Promise<PlanReadiness> {
  const row = await queryOne<{ instagram: number; inbound: number; tagged: number; clients: number }>(
    db,
    `SELECT
       (SELECT COUNT(*)::int FROM platform_accounts WHERE tenant_id = ? AND platform = 'instagram' AND status = 'active' AND is_test = false) AS instagram,
       (SELECT COUNT(*)::int FROM messages WHERE tenant_id = ? AND direction = 'in') AS inbound,
       (SELECT COUNT(DISTINCT subscriber_tags.subscriber_id)::int FROM subscriber_tags JOIN tags ON tags.id = subscriber_tags.tag_id WHERE tags.tenant_id = ?) AS tagged,
       (SELECT COUNT(*)::int FROM subscribers WHERE tenant_id = ? AND lead_status = 'client') AS clients`,
    tenantId,
    tenantId,
    tenantId,
    tenantId
  );
  const signals = await collectSignals(db, tenantId);
  const clientMessages = signals.reduce((sum, s) => sum + s.clientMessages.length, 0);
  return {
    instagramConnected: (row?.instagram ?? 0) > 0,
    inboundMessages: row?.inbound ?? 0,
    taggedSubscribers: row?.tagged ?? 0,
    clients: row?.clients ?? 0,
    clientMessages,
    ready: clientMessages >= MIN_CLIENT_MESSAGES,
  };
}

// ---- Asking, and checking the answer ---------------------------------------

const PLAN_SYSTEM =
  'Ты контент-стратег для блогеров и экспертов, которые продают через директ Instagram. ' +
  'Тебе дают сегменты аудитории (теги CRM) и сообщения из директа: отдельно от тех, кто купил, и от тех, кто не купил. ' +
  'Найди, о чём спрашивают и что волнует именно купивших, и предложи темы коротких вертикальных видео, которые привлекут таких же людей. ' +
  'Опирайся ТОЛЬКО на сообщения. Каждая тема обязана иметь 1–3 цитаты — ДОСЛОВНЫЕ отрывки из сообщений купивших этого сегмента, без изменений. ' +
  'Ответь строго JSON без markdown: {"topics": [{"title": string, "segment": string, "why": string, "quotes": [string]}]}. ' +
  'title — рабочее название ролика, цепляющее, до 80 символов. segment — точное имя сегмента из входных данных. ' +
  'why — 1–2 предложения: какое конкретное сомнение или желание купивших закрывает ролик и почему он приведёт таких же. ' +
  'Без общих фраз вроде «это важная тема» или «актуально для многих» — только то, что видно в сообщениях. ' +
  'От 3 до 6 тем, самые сильные первыми. Пиши по-русски.';

const SCRIPT_SYSTEM =
  'Ты пишешь сценарии коротких вертикальных видео (Reels, TikTok, Shorts) для блогеров. ' +
  'Тебе дают тему, сегмент аудитории и реальные вопросы покупателей из директа. ' +
  'Напиши сценарий на 30–60 секунд, который отвечает на эти вопросы: хук в первые 2 секунды, суть, призыв написать в директ. ' +
  'По частям, с названием каждой части, так, чтобы можно было сразу произнести на камеру. ' +
  'Ответь строго JSON без markdown: {"script": string}. Пиши по-русски.';

function promptFor(signals: SegmentSignal[]): string {
  return signals
    .map((s) => {
      const clients = s.clientMessages.map((m) => `- ${m}`).join('\n');
      const others = s.otherMessages.length ? s.otherMessages.map((m) => `- ${m}`).join('\n') : '(нет)';
      return (
        `Сегмент: ${s.segment}\nКонтактов: ${s.subscriberCount}, купили: ${s.clientCount}\n` +
        `Сообщения купивших:\n${clients}\nСообщения не купивших:\n${others}`
      );
    })
    .join('\n\n');
}

function normalise(text: string): string {
  return text
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?;:…-]+|[\s.,!?;:…-]+$/g, '')
    .trim();
}

/**
 * The model's topics, kept only where their evidence is real.
 *
 * A quote counts if, give or take case, quotes and edge punctuation, it is a
 * substring of a buyer's message in the segment it names. Short fragments
 * ("да", "цена?") do not count: they would match anything.
 */
export function parseTopics(content: string, signals: SegmentSignal[]): ContentTopic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ReelAnalysisError('llm_invalid_answer', 'not JSON');
  }
  const raw = (parsed as { topics?: unknown }).topics;
  if (!Array.isArray(raw)) throw new ReelAnalysisError('llm_invalid_answer', 'no topics');

  const bySegment = new Map(signals.map((s) => [normalise(s.segment), s]));
  const topics: ContentTopic[] = [];
  for (const item of raw) {
    const t = item as { title?: unknown; segment?: unknown; why?: unknown; quotes?: unknown };
    if (typeof t.title !== 'string' || typeof t.segment !== 'string') continue;
    const signal = bySegment.get(normalise(t.segment));
    if (!signal) continue;
    const haystack = signal.clientMessages.map(normalise);
    const quotes = (Array.isArray(t.quotes) ? t.quotes : [])
      .filter((q): q is string => typeof q === 'string')
      .map((q) => q.trim().replace(/^[«"“]|[»"”]$/g, ''))
      .filter((q) => normalise(q).length >= 8 && haystack.some((m) => m.includes(normalise(q))))
      .slice(0, 3);
    if (quotes.length === 0) continue;
    const title = t.title.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!title) continue;
    topics.push({
      id: randomBytes(6).toString('hex'),
      title,
      segment: signal.segment,
      why: typeof t.why === 'string' ? t.why.trim().replace(/\s+/g, ' ').slice(0, 400) : '',
      quotes,
      clientCount: signal.clientCount,
      subscriberCount: signal.subscriberCount,
    });
    if (topics.length >= 6) break;
  }
  if (topics.length === 0) throw new ReelAnalysisError('llm_invalid_answer', 'no topic with real evidence');
  return topics;
}

export class NotEnoughDataError extends Error {
  constructor() {
    super('not_enough_data');
    this.name = 'NotEnoughDataError';
  }
}

export async function generateContentPlan(db: Db, tenantId: string, chat: ChatModel, now: Date = new Date()): Promise<ContentPlan> {
  const signals = await collectSignals(db, tenantId);
  if (signals.reduce((sum, s) => sum + s.clientMessages.length, 0) < MIN_CLIENT_MESSAGES) throw new NotEnoughDataError();

  const topics = parseTopics(await chat(PLAN_SYSTEM, promptFor(signals)), signals);
  const hash = await sourceHash(db, tenantId);
  await exec(
    db,
    `INSERT INTO content_plans (tenant_id, topics, source_hash, generated_at) VALUES (?, ?::jsonb, ?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET topics = EXCLUDED.topics, source_hash = EXCLUDED.source_hash, generated_at = EXCLUDED.generated_at`,
    tenantId,
    JSON.stringify(topics),
    hash,
    now.toISOString()
  );
  return { topics, generatedAt: now.toISOString(), stale: false };
}

export async function getContentPlan(db: Db, tenantId: string): Promise<ContentPlan | null> {
  const row = await queryOne<{ topics: ContentTopic[]; source_hash: string; generated_at: string }>(
    db,
    `SELECT topics, source_hash, generated_at FROM content_plans WHERE tenant_id = ?`,
    tenantId
  );
  if (!row) return null;
  return { topics: row.topics, generatedAt: row.generated_at, stale: row.source_hash !== (await sourceHash(db, tenantId)) };
}

/**
 * Takes a contact's words out of the saved plan — the right to erasure under
 * Kazakhstan's personal data law reaches the quotes too, not only the
 * messages they were taken from. A topic left with no quote goes as well:
 * without its evidence it is exactly the made-up topic this module refuses
 * to show.
 *
 * Runs inside the caller's transaction, before the messages are deleted —
 * they are what says which quotes were this person's.
 */
export async function eraseContactFromPlan(client: Queryable, tenantId: string, subscriberId: string): Promise<void> {
  const plan = await queryOne<{ topics: ContentTopic[] }>(
    client,
    `SELECT topics FROM content_plans WHERE tenant_id = ? FOR UPDATE`,
    tenantId
  );
  if (!plan) return;
  const said = (
    await queryAll<{ content: string }>(client, `SELECT content FROM messages WHERE subscriber_id = ? AND direction = 'in'`, subscriberId)
  ).map((m) => normalise(maskPersonalData(m.content)));
  if (said.length === 0) return;

  const theirs = (quote: string) => said.some((message) => message.includes(normalise(quote)));
  const topics = plan.topics
    .map((topic) => ({ ...topic, quotes: topic.quotes.filter((q) => !theirs(q)) }))
    .filter((topic) => topic.quotes.length > 0);
  await exec(client, `UPDATE content_plans SET topics = ?::jsonb WHERE tenant_id = ?`, JSON.stringify(topics), tenantId);
}

/** A script for a topic — or for a calendar entry whose topic a rebuilt plan
 *  no longer has, in which case there are no quotes to go on, only the title. */
export async function scriptFor(
  topic: { title: string; segment: string; why?: string; quotes?: string[] },
  chat: ChatModel
): Promise<string> {
  const quotes = topic.quotes?.length ? topic.quotes.map((q) => `- ${q}`).join('\n') : '(нет)';
  const user = `Тема: ${topic.title}\nСегмент: ${topic.segment}\nПочему: ${topic.why || '—'}\nВопросы покупателей:\n${quotes}`;
  return parseScript(await chat(SCRIPT_SYSTEM, user));
}

/** A script for one topic, saved onto it so it survives a reload. */
export async function writeTopicScript(db: Db, tenantId: string, topicId: string, chat: ChatModel): Promise<ContentTopic | null> {
  const plan = await queryOne<{ topics: ContentTopic[] }>(db, `SELECT topics FROM content_plans WHERE tenant_id = ?`, tenantId);
  const topic = plan?.topics.find((t) => t.id === topicId);
  if (!plan || !topic) return null;

  const updated = { ...topic, script: await scriptFor(topic, chat) };
  // jsonb_set on the topic's position, under the same plan the topic was read
  // from: a plan regenerated meanwhile has other topic ids, and then this
  // write matches nothing rather than grafting a script onto the wrong topic.
  const index = plan.topics.findIndex((t) => t.id === topicId);
  await exec(
    db,
    `UPDATE content_plans SET topics = jsonb_set(topics, ?::text[], ?::jsonb)
     WHERE tenant_id = ? AND topics -> (?::int) ->> 'id' = ?`,
    `{${index}}`,
    JSON.stringify(updated),
    tenantId,
    index,
    topicId
  );
  // The same topic laid out in the calendar shows the same script.
  await exec(db, `UPDATE content_calendar SET script = ? WHERE tenant_id = ? AND topic_id = ?`, updated.script, tenantId, topicId);
  return updated;
}
