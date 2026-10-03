import { createHash } from 'node:crypto';
import { exec, queryAll, queryOne, type Db } from './db';
import {
  containerStatus,
  createReelContainer,
  InstagramPublishError,
  mediaPermalink,
  publishContainer,
  publishingQuotaLeft,
} from './instagramPublish';
import { notify } from './notifications';
import { markNeedsReconnect, openToken, type PlatformAccountRow } from './platformAccounts';
import { presign, storageConfigFromEnv } from './storage';
import { keyringFromEnv, type TokenKeyring } from './tokenVault';
import type { PostingPlatform, PublishFailureReason, ScheduledPost } from './types';

const FAILURE_REASONS: PublishFailureReason[] = ['token_expired', 'rejected_by_platform', 'rate_limited'];

const FAILURE_TEXT: Record<PublishFailureReason, string> = {
  token_expired: 'доступ к аккаунту истёк, подключите его заново',
  rejected_by_platform: 'платформа отклонила публикацию',
  rate_limited: 'слишком много публикаций подряд, платформа просит подождать',
  no_video: 'к посту не прикреплено видео',
  processing_failed: 'Instagram не смог обработать видео',
  processing_timeout: 'Instagram слишком долго обрабатывал видео',
  publish_failed: 'Instagram не отвечал несколько раз подряд',
  account_unavailable: 'аккаунт сейчас недоступен для публикации',
};

// A claim lasts one pass: at most a handful of Instagram calls, each with a
// 30-second timeout. A claim older than this means the process died mid-pass,
// and the row is safe to pick up again — publish_stage says how far it got.
const STUCK_PUBLISHING_MS = 2 * 60 * 1000;
// Posts claimed per pass. A pass with real network calls takes seconds per
// post; an unbounded claim could leave its tail sitting claimed past the
// stuck threshold, to be reclaimed while still being worked on.
const CLAIM_LIMIT = 20;

// How often a container still transcoding is asked about, and for how long.
const CONTAINER_POLL_MS = 20 * 1000;
const CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;
// Network errors and Meta's own bad minutes: retried with backoff, then given up.
const MAX_TRANSIENT_ATTEMPTS = 5;
// Instagram's daily limit reached: try again after this.
const QUOTA_WAIT_MS = 60 * 60 * 1000;
/**
 * Our own pace: at least this long between two posts to the same account.
 * Instagram's limit is about volume per day; this is about not looking like
 * a bot — a burst of reels a minute apart is exactly the pattern that gets
 * an account restricted, which is the risk CLAUDE.md's security section
 * names for autoposting.
 */
export const MIN_GAP_PER_ACCOUNT_MS = 10 * 60 * 1000;
// How long Instagram has to fetch the video from storage.
const VIDEO_URL_TTL_SEC = 24 * 60 * 60;

export interface PublishDeps {
  keyring: TokenKeyring | null;
  fetchImpl: typeof fetch;
  /** A URL Instagram's servers can download the video from, or null when
   *  there is no public storage to sign one for. */
  videoUrl: (objectKey: string) => string | null;
}

export function defaultPublishDeps(): PublishDeps {
  return {
    keyring: keyringFromEnv(),
    fetchImpl: fetch,
    videoUrl: (key) => {
      const storage = storageConfigFromEnv();
      return storage ? presign(storage, { method: 'GET', key, expiresInSec: VIDEO_URL_TTL_SEC }) : null;
    },
  };
}

// Stands in for TikTok and YouTube, and for Instagram where there is no real
// account to post to (none connected, or the development test account).
// Deterministic per post id so the failure path is reproducible in tests —
// about 1 in 10 "fails".
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

// Finds due posts — and posts already on their way whose next step is due —
// and moves each one step on. Runs on a timer in server.ts, and from the
// manual "process due now" endpoint, which MUST pass its tenantId: without
// it any tenant could publish another tenant's posts to that tenant's real
// account (CLAUDE.md, multi-tenancy).
export async function publishDuePosts(
  db: Db,
  now: Date = new Date(),
  tenantId?: string,
  deps: PublishDeps = defaultPublishDeps()
): Promise<{ processed: number }> {
  // Claimed in the statement that selects them, so two overlapping passes
  // can never both take a row. SKIP LOCKED lets them share a backlog instead
  // of queueing behind each other. Three ways a row is due:
  //   - scheduled, and its time has come;
  //   - on its way (released between Instagram calls), and its next step is due;
  //   - claimed by a pass that died — its claim is older than any real pass.
  const due = await queryAll<ScheduledPost>(
    db,
    `UPDATE scheduled_posts
     SET status = 'publishing', claimed_at = ?
     WHERE id IN (
       SELECT id FROM scheduled_posts
       WHERE ((status = 'scheduled' AND scheduled_at <= ?)
          OR (status = 'publishing' AND claimed_at IS NULL AND next_attempt_at <= ?)
          OR (status = 'publishing' AND claimed_at < ?))
         AND (?::text IS NULL OR tenant_id = ?)
       ORDER BY scheduled_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    now.toISOString(),
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() - STUCK_PUBLISHING_MS).toISOString(),
    // The cast is required: a NULL bound to a bare placeholder leaves
    // Postgres nothing to infer its type from.
    tenantId ?? null,
    tenantId ?? null,
    CLAIM_LIMIT
  );

  // Bounded concurrency under the pg pool's 10 connections, so a claimed
  // row is always actively being worked on — the assumption the stuck-claim
  // reclaim above rests on.
  await forEachBounded(due, PUBLISH_CONCURRENCY, (post) =>
    processOnePost(db, post, now, deps).catch((err) => {
      // Released for the stuck-claim path rather than left to look in
      // flight. Whatever this was, it is not a reason to publish twice:
      // publish_stage keeps how far the post got.
      console.error(`[publisher] ${post.id}: pass failed`, err instanceof Error ? err.message : err);
    })
  );

  return { processed: due.length };
}

const PUBLISH_CONCURRENCY = 5;

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

/** What the person calls it, for notification text. */
export const PLATFORM_NAME: Record<PostingPlatform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
};

async function processOnePost(db: Db, post: ScheduledPost, now: Date, deps: PublishDeps): Promise<void> {
  // Every platform here publishes video. A post from before posts carried
  // one has nothing to send.
  if (!post.video_object_key) return fail(db, post, 'no_video');

  const account = post.platform_account_id
    ? await queryOne<PlatformAccountRow>(db, `SELECT * FROM platform_accounts WHERE id = ? AND tenant_id = ?`, post.platform_account_id, post.tenant_id)
    : undefined;

  if (post.platform === 'instagram' && account && !account.is_test) return publishToInstagram(db, post, account, now, deps);
  // A post pointed at an account that has since been disconnected must not
  // fall through to the mock and report "published".
  if (post.platform_account_id && !account) return fail(db, post, 'account_unavailable');
  return publishMock(db, post, now);
}

async function publishMock(db: Db, post: ScheduledPost, now: Date): Promise<void> {
  const result = mockPublish(post.id, post.platform);
  if (!result.success) return fail(db, post, result.reason);
  await markPublished(db, post, now, result.externalPostUrl);
}

/**
 * One step of Instagram's container flow per pass. Between steps the row is
 * released with a time to come back, so a reel transcoding for minutes holds
 * no claim and no connection.
 */
async function publishToInstagram(db: Db, post: ScheduledPost, account: PlatformAccountRow, now: Date, deps: PublishDeps): Promise<void> {
  if (account.status !== 'active') return fail(db, post, 'token_expired');
  if (!deps.keyring) return fail(db, post, 'account_unavailable');
  let token: string;
  try {
    token = openToken(deps.keyring, account);
  } catch {
    return fail(db, post, 'account_unavailable');
  }

  try {
    if (!post.ig_container_id) {
      // Instagram's quota first: asking costs a call but takes nothing, while
      // the pace slot below, once taken, is spent.
      if ((await publishingQuotaLeft(deps.fetchImpl, token, account.external_user_id)) <= 0) {
        return wait(db, post, new Date(now.getTime() + QUOTA_WAIT_MS), 'instagram_limit');
      }

      // Our pace, taken atomically: one statement both checks that the
      // account's window is free and claims it. A read-then-decide check let
      // two posts due together, processed side by side, both see an empty
      // window and both go out seconds apart — the burst the gap exists to
      // prevent. Atomic in the database, it holds across overlapping passes
      // and across processes too.
      const slot = await queryOne<{ id: string }>(
        db,
        `UPDATE platform_accounts SET last_publish_slot_at = ?
         WHERE id = ? AND (last_publish_slot_at IS NULL OR last_publish_slot_at <= ?)
         RETURNING id`,
        now.toISOString(),
        account.id,
        new Date(now.getTime() - MIN_GAP_PER_ACCOUNT_MS).toISOString()
      );
      if (!slot) {
        const taken = await queryOne<{ at: string }>(db, `SELECT last_publish_slot_at::text AS at FROM platform_accounts WHERE id = ?`, account.id);
        const from = taken?.at ? new Date(taken.at).getTime() : now.getTime();
        return wait(db, post, new Date(from + MIN_GAP_PER_ACCOUNT_MS), 'pace');
      }

      const videoUrl = deps.videoUrl(post.video_object_key!);
      if (!videoUrl) return fail(db, post, 'account_unavailable', 'no public storage to hand Instagram the video');

      let containerId: string;
      try {
        containerId = await createReelContainer(deps.fetchImpl, token, account.external_user_id, videoUrl, post.caption);
      } catch (err) {
        // Nothing was created on Instagram, so the slot was not used: give it
        // back, or a retry a minute from now would sit out the whole gap.
        // Only if it is still ours — another post may have taken it since.
        await exec(
          db,
          `UPDATE platform_accounts SET last_publish_slot_at = NULL WHERE id = ? AND last_publish_slot_at = ?`,
          account.id,
          now.toISOString()
        );
        throw err;
      }
      await exec(
        db,
        `UPDATE scheduled_posts
         SET ig_container_id = ?, publish_stage = 'container', container_created_at = ?, next_attempt_at = ?,
             claimed_at = NULL, waiting_reason = NULL, attempts = 0
         WHERE id = ?`,
        containerId,
        now.toISOString(),
        new Date(now.getTime() + CONTAINER_POLL_MS).toISOString(),
        post.id
      );
      return;
    }

    const { status, detail } = await containerStatus(deps.fetchImpl, token, post.ig_container_id);
    if (status === 'PUBLISHED') {
      // Published by an earlier pass whose answer never reached us — the
      // reason this is checked before publishing, every time.
      return markPublished(db, post, now, null);
    }
    if (status === 'ERROR' || status === 'EXPIRED') return fail(db, post, 'processing_failed', detail);
    if (status === 'IN_PROGRESS') {
      const started = post.container_created_at ? new Date(post.container_created_at).getTime() : now.getTime();
      if (now.getTime() - started > CONTAINER_TIMEOUT_MS) return fail(db, post, 'processing_timeout');
      return release(db, post, new Date(now.getTime() + CONTAINER_POLL_MS));
    }

    // FINISHED: transcoded and not yet published. Mark the attempt before
    // making it, so a pass that dies inside the call leaves a trace the next
    // one checks (the PUBLISHED branch above).
    await exec(db, `UPDATE scheduled_posts SET publish_stage = 'publishing' WHERE id = ?`, post.id);
    const mediaId = await publishContainer(deps.fetchImpl, token, account.external_user_id, post.ig_container_id);
    await markPublished(db, post, now, await mediaPermalink(deps.fetchImpl, token, mediaId));
  } catch (err) {
    if (!(err instanceof InstagramPublishError)) throw err;
    if (err.kind === 'token_invalid') {
      await markNeedsReconnect(db, account);
      return fail(db, post, 'token_expired');
    }
    if (err.kind === 'rate_limited') return wait(db, post, new Date(now.getTime() + QUOTA_WAIT_MS), 'instagram_limit');
    if (err.kind === 'rejected') return fail(db, post, 'rejected_by_platform', err.message.replace(/^rejected: /, ''));
    // transient
    const attempts = post.attempts + 1;
    if (attempts >= MAX_TRANSIENT_ATTEMPTS) return fail(db, post, 'publish_failed', err.message);
    await exec(
      db,
      `UPDATE scheduled_posts SET attempts = ?, next_attempt_at = ?, claimed_at = NULL WHERE id = ?`,
      attempts,
      new Date(now.getTime() + 60_000 * 2 ** (attempts - 1)).toISOString(),
      post.id
    );
  }
}

/** Back in the queue at `at`, still on its way. */
async function release(db: Db, post: ScheduledPost, at: Date): Promise<void> {
  await exec(db, `UPDATE scheduled_posts SET next_attempt_at = ?, claimed_at = NULL WHERE id = ?`, at.toISOString(), post.id);
}

/** Back in the queue at `at`, with the reason it is waiting shown on the card. */
async function wait(db: Db, post: ScheduledPost, at: Date, reason: 'pace' | 'instagram_limit'): Promise<void> {
  await exec(
    db,
    `UPDATE scheduled_posts SET next_attempt_at = ?, waiting_reason = ?, claimed_at = NULL WHERE id = ?`,
    at.toISOString(),
    reason,
    post.id
  );
}

async function markPublished(db: Db, post: ScheduledPost, now: Date, url: string | null): Promise<void> {
  await exec(
    db,
    `UPDATE scheduled_posts
     SET status = 'published', published_at = ?, external_post_url = ?, claimed_at = NULL, waiting_reason = NULL, next_attempt_at = NULL
     WHERE id = ?`,
    now.toISOString(),
    url,
    post.id
  );
  const name = PLATFORM_NAME[post.platform] ?? post.platform;
  await notify(db, post.tenant_id, 'post_published', `Пост в ${name} опубликован`, post.id);
}

async function fail(db: Db, post: ScheduledPost, reason: PublishFailureReason, detail?: string): Promise<void> {
  if (detail) console.warn(`[publisher] ${post.id} failed (${reason}): ${detail.slice(0, 300)}`);
  await exec(
    db,
    `UPDATE scheduled_posts
     SET status = 'failed', failure_reason = ?, failure_detail = ?, claimed_at = NULL, waiting_reason = NULL, next_attempt_at = NULL
     WHERE id = ?`,
    reason,
    reason === 'rejected_by_platform' || reason === 'processing_failed' ? detail?.slice(0, 300) ?? null : null,
    post.id
  );
  const name = PLATFORM_NAME[post.platform] ?? post.platform;
  await notify(db, post.tenant_id, 'post_failed', `Не удалось опубликовать в ${name}: ${FAILURE_TEXT[reason]}`, post.id);
}
