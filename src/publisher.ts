import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { notify } from './notifications';
import type { PostingPlatform, PublishFailureReason, ScheduledPost } from './types';

const FAILURE_REASONS: PublishFailureReason[] = ['token_expired', 'rejected_by_platform', 'rate_limited'];

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
export function publishDuePosts(db: Database.Database, now: Date = new Date()): { processed: number } {
  const due = db
    .prepare(`SELECT * FROM scheduled_posts WHERE status = 'scheduled' AND scheduled_at <= ?`)
    .all(now.toISOString()) as ScheduledPost[];

  for (const post of due) {
    const result = mockPublish(post.id, post.platform);
    if (result.success) {
      db.prepare(`UPDATE scheduled_posts SET status = 'published', published_at = ?, external_post_url = ? WHERE id = ?`).run(
        now.toISOString(),
        result.externalPostUrl,
        post.id
      );
      notify(db, post.tenant_id, 'post_published', `Пост в ${post.platform} опубликован: ${result.externalPostUrl}`, post.id);
    } else {
      db.prepare(`UPDATE scheduled_posts SET status = 'failed', failure_reason = ? WHERE id = ?`).run(result.reason, post.id);
      notify(db, post.tenant_id, 'post_failed', `Ошибка публикации в ${post.platform}: ${result.reason}`, post.id);
    }
  }

  return { processed: due.length };
}
