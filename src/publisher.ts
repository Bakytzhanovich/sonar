import { createHash } from 'node:crypto';
import { exec, queryAll, type Db } from './db';
import { notify } from './notifications';
import type { PostingPlatform, PublishFailureReason, ScheduledPost } from './types';

const FAILURE_REASONS: PublishFailureReason[] = ['token_expired', 'rejected_by_platform', 'rate_limited'];

// A live claim only ever holds 'publishing' for the duration of one
// synchronous-ish processing pass within this same Node process (the mock
// publish call plus a couple of awaited queries) — well under a second in
// practice. A claim still sitting there past this threshold can only mean
// the process crashed or threw between claiming the row and writing its
// final status, so it's safe to treat as orphaned and reclaim.
const STUCK_PUBLISHING_MS = 2 * 60 * 1000;

// Stands in for Instagram Content Publishing API / TikTok Content Posting
// API / YouTube Data API — each needs its own real app review we don't
// have yet. Deterministic per post id (same post always resolves the same
// way) so the failure path is reproducible in tests, not flaky — about
// 1 in 10 posts "fails" with one of the three reasons the ТЗ's push
// section lists, so both paths get exercised without a magic keyword.
export function mockPublish(
  postId: string,
  platform: PostingPlatform
): { success: true; externalPostUrl: string } | { success: false; reason: PublishFailureReason } {
  const hash = createHash('sha256').update(postId).digest();
  if (hash[0] % 10 === 0) {
    return { success: false, reason: FAILURE_REASONS[hash[1] % FAILURE_REASONS.length] };
  }
  return { success: true, externalPostUrl: `https://${platform}.mock/p/${postId.slice(0, 8)}` };
}

// Finds every due, approved post and "publishes" it. No Redis/BullMQ (see
// schema.sql) — this runs on a setInterval in server.ts, and is called
// directly with an injected `now` by tests and by the manual
// "process due now" endpoint (useful for demos, since there's no real
// queue to trigger).
// tenantId scopes the claim to one tenant's rows. It is optional because
// there are two legitimate callers with different trust levels: the
// setInterval timer in server.ts is server-side infrastructure and
// deliberately sweeps every tenant, while the manual
// POST /api/scheduled-posts/process-due endpoint is reachable by any
// authenticated tenant and MUST pass its own id — without that, tenant B
// calling the endpoint published tenant A's private scheduled posts (a real
// post to A's real Instagram, plus a push notification to A's owner), which
// breaks CLAUDE.md's requirement that one client's data is never visible to
// another.
export async function publishDuePosts(db: Db, now: Date = new Date(), tenantId?: string): Promise<{ processed: number }> {
  // Claims due rows atomically in the same statement that selects them, by
  // flipping them out of 'scheduled' — the setInterval timer in server.ts
  // and the manual POST /api/scheduled-posts/process-due endpoint can now
  // overlap (every DB call here is an await point another tick or request
  // can interleave at, unlike the old synchronous SQLite version). A plain
  // SELECT-then-loop-UPDATE would let two overlapping calls both grab and
  // double-publish/double-notify the same row.
  //
  // Also reclaims any row still stuck in 'publishing' from a previous claim
  // older than STUCK_PUBLISHING_MS — a process crash or an unexpected throw
  // between claiming a row and writing its final status would otherwise
  // leave it stuck there forever, invisible to every future tick (which
  // only ever selected 'scheduled' rows). The staleness check is what makes
  // this safe alongside a genuinely in-flight claim from an overlapping
  // call: that one is still within its very first pass and won't be older
  // than the threshold yet.
  const due = await queryAll<ScheduledPost>(
    db,
    `UPDATE scheduled_posts
     SET status = 'publishing', claimed_at = ?
     WHERE ((status = 'scheduled' AND scheduled_at <= ?)
        OR (status = 'publishing' AND claimed_at < ?))
       AND (?::text IS NULL OR tenant_id = ?)
     RETURNING *`,
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() - STUCK_PUBLISHING_MS).toISOString(),
    // Cast is required, not cosmetic: with a NULL bound to a bare
    // placeholder Postgres has nothing to infer the parameter type from and
    // rejects the statement outright ("could not determine data type").
    tenantId ?? null,
    tenantId ?? null
  );

  // Each post was already atomically claimed above (own row, own
  // WHERE-guarded UPDATE) — nothing here depends on another post's
  // outcome, so processing them concurrently instead of one at a time is
  // safe and turns N sequential round-trips into N parallel ones.
  //
  // Bounded, though, rather than one Promise.all over the whole batch: the
  // pg pool holds 10 connections, so a large due batch left its tail
  // waiting on a connection while already claimed. Once that wait pushed a
  // row past STUCK_PUBLISHING_MS, the next tick reclaimed it as orphaned
  // and published it a second time — a duplicate post on the client's real
  // account. Keeping in-flight work under the pool size means a claimed row
  // is always actively being processed, which is the assumption the stale-
  // claim reclaim above is built on.
  await forEachBounded(due, PUBLISH_CONCURRENCY, (post) => processOnePost(db, post, now));

  return { processed: due.length };
}

// Stays under the pg pool's 10 connections so claimed rows are never left
// queueing for one (see publishDuePosts above).
const PUBLISH_CONCURRENCY = 5;

// A fixed number of workers pulling from a shared cursor — keeps at most
// `limit` tasks in flight without pulling in a dependency.
async function forEachBounded<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function processOnePost(db: Db, post: ScheduledPost, now: Date): Promise<void> {
  const result = mockPublish(post.id, post.platform);
  if (result.success) {
    await exec(
      db,
      `UPDATE scheduled_posts SET status = 'published', published_at = ?, external_post_url = ? WHERE id = ?`,
      now.toISOString(),
      result.externalPostUrl,
      post.id
    );
    await notify(db, post.tenant_id, 'post_published', `Пост в ${post.platform} опубликован: ${result.externalPostUrl}`, post.id);
  } else {
    await exec(db, `UPDATE scheduled_posts SET status = 'failed', failure_reason = ? WHERE id = ?`, result.reason, post.id);
    await notify(db, post.tenant_id, 'post_failed', `Ошибка публикации в ${post.platform}: ${result.reason}`, post.id);
  }
}
