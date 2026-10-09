// The home screen: what is happening across the workspace, and the one thing
// worth doing next. Every module already answers its own question; this is the
// only place that weighs them against each other, which is why the choice is
// a pure function (chooseNextStep) and the gathering is separate from it.

import { queryAll, queryOne, type Db } from './db';
import { getContentPlan, type ContentTopic } from './contentTopics';

/** Instagram lets a business answer a DM freely for 24 hours after the
 *  person's last message (CLAUDE.md, decision 2). */
export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A question whose window closes sooner than this outranks everything:
 *  after it closes the person can no longer be answered in the DM at all. */
export const URGENT_REPLY_MS = 6 * 60 * 60 * 1000;
/** Same "active right now" as the CRM's live indicator. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

export interface UnansweredQuestion {
  subscriberId: string;
  name: string;
  text: string;
  askedAt: string;
  windowClosesAt: string;
}

export interface HomeJob {
  id: string;
  title: string;
  status: 'processing' | 'awaiting_review';
  progress: number;
}

export interface HomePost {
  caption: string;
  platform: string;
  scheduledAt: string;
}

export interface HomeState {
  hasBot: boolean;
  activeDialogs: number;
  unanswered: UnansweredQuestion[];
  recentMessages: Array<{ name: string; text: string; at: string }>;
  jobs: HomeJob[];
  topic: ContentTopic | null;
  topicCount: number;
  nextPost: HomePost | null;
  week: { inbound: number; clients: number };
}

export type NextStep =
  | { kind: 'reply'; question: UnansweredQuestion; others: number }
  | { kind: 'review_captions'; job: HomeJob }
  | { kind: 'film_topic'; topic: ContentTopic }
  | { kind: 'make_video' };

/**
 * The main step and what follows it, in order of what is lost by waiting:
 * a buyer whose DM window is about to close is gone for good; a video held
 * for caption review blocks a render already paid for; a topic from buyers'
 * questions is the next video; and with nothing pending, the next video
 * itself. A reply that is not yet urgent still comes after the topic but
 * before nothing.
 */
export function chooseNextStep(state: HomeState, now: Date): { step: NextStep; more: NextStep[] } {
  const open = state.unanswered.filter((q) => new Date(q.windowClosesAt).getTime() > now.getTime());
  const soonest = [...open].sort((a, b) => a.windowClosesAt.localeCompare(b.windowClosesAt))[0];
  const reply: NextStep | null = soonest ? { kind: 'reply', question: soonest, others: open.length - 1 } : null;
  const urgent = soonest !== undefined && new Date(soonest.windowClosesAt).getTime() - now.getTime() <= URGENT_REPLY_MS;
  const review = state.jobs.find((j) => j.status === 'awaiting_review');

  const ordered: NextStep[] = [];
  if (reply && urgent) ordered.push(reply);
  if (review) ordered.push({ kind: 'review_captions', job: review });
  if (state.topic) ordered.push({ kind: 'film_topic', topic: state.topic });
  if (reply && !urgent) ordered.push(reply);

  const [step, ...more] = ordered;
  return { step: step ?? { kind: 'make_video' }, more: more.slice(0, 3) };
}

function contactName(row: { display_name: string | null; username: string | null; external_user_id: string }): string {
  return row.display_name || (row.username ? `@${row.username}` : row.external_user_id);
}

function jobTitle(row: { headline: string | null; created_at: string }): string {
  if (row.headline?.trim()) return row.headline.trim();
  const date = new Date(row.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `Ролик от ${date}`;
}

export async function gatherHomeState(db: Db, tenantId: string, now: Date = new Date()): Promise<HomeState> {
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();

  const [bot, active, unanswered, recent, jobs, plan, nextPost, inbound, clients] = await Promise.all([
    queryOne<{ id: string }>(db, `SELECT id FROM bots WHERE tenant_id = ? LIMIT 1`, tenantId),
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*)::int AS n FROM subscribers WHERE tenant_id = ? AND last_interacted_at > ?`,
      tenantId,
      since(ACTIVE_WINDOW_MS)
    ),
    // A contact whose latest message is theirs: nothing — not the bot, not a
    // person — has answered since. Only inside the window, since past it the
    // question can no longer be answered in the DM anyway.
    queryAll<{ id: string; display_name: string | null; username: string | null; external_user_id: string; content: string; created_at: string }>(
      db,
      `SELECT s.id, s.display_name, s.username, s.external_user_id, m.content, m.created_at
       FROM subscribers s
       JOIN LATERAL (
         SELECT direction, content, created_at FROM messages
         WHERE subscriber_id = s.id ORDER BY created_at DESC, seq DESC LIMIT 1
       ) m ON true
       WHERE s.tenant_id = ? AND m.direction = 'in' AND m.created_at > ?
       ORDER BY m.created_at ASC
       LIMIT 20`,
      tenantId,
      since(DM_WINDOW_MS)
    ),
    queryAll<{ display_name: string | null; username: string | null; external_user_id: string; content: string; created_at: string }>(
      db,
      `SELECT s.display_name, s.username, s.external_user_id, m.content, m.created_at
       FROM messages m JOIN subscribers s ON s.id = m.subscriber_id
       WHERE m.tenant_id = ? AND m.direction = 'in'
       ORDER BY m.created_at DESC, m.seq DESC
       LIMIT 3`,
      tenantId
    ),
    queryAll<{ id: string; status: 'processing' | 'awaiting_review'; progress_percent: number; headline: string | null; created_at: string }>(
      db,
      `SELECT id, status, progress_percent, headline, created_at FROM video_edit_jobs
       WHERE tenant_id = ? AND preview_of IS NULL AND status IN ('processing', 'awaiting_review')
       ORDER BY created_at DESC LIMIT 5`,
      tenantId
    ),
    getContentPlan(db, tenantId),
    queryOne<{ caption: string; platform: string; scheduled_at: string }>(
      db,
      `SELECT caption, platform, scheduled_at FROM scheduled_posts
       WHERE tenant_id = ? AND status IN ('scheduled', 'pending_approval') AND scheduled_at > ?
       ORDER BY scheduled_at ASC LIMIT 1`,
      tenantId,
      now.toISOString()
    ),
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id = ? AND direction = 'in' AND created_at > ?`,
      tenantId,
      since(7 * 24 * 60 * 60 * 1000)
    ),
    queryOne<{ n: number }>(db, `SELECT COUNT(*)::int AS n FROM subscribers WHERE tenant_id = ? AND lead_status = 'client'`, tenantId),
  ]);

  return {
    hasBot: bot !== null,
    activeDialogs: active?.n ?? 0,
    unanswered: unanswered.map((r) => ({
      subscriberId: r.id,
      name: contactName(r),
      text: r.content,
      askedAt: new Date(r.created_at).toISOString(),
      windowClosesAt: new Date(new Date(r.created_at).getTime() + DM_WINDOW_MS).toISOString(),
    })),
    recentMessages: recent.map((r) => ({ name: contactName(r), text: r.content, at: new Date(r.created_at).toISOString() })),
    jobs: jobs.map((j) => ({ id: j.id, title: jobTitle(j), status: j.status, progress: j.progress_percent })),
    topic: plan?.topics[0] ?? null,
    topicCount: plan?.topics.length ?? 0,
    nextPost: nextPost ? { caption: nextPost.caption, platform: nextPost.platform, scheduledAt: new Date(nextPost.scheduled_at).toISOString() } : null,
    week: { inbound: inbound?.n ?? 0, clients: clients?.n ?? 0 },
  };
}
