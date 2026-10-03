import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { exec, queryAll, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import { classifyGraphError } from '../src/instagramPublish';
import { saveConnectedAccount } from '../src/platformAccounts';
import { MIN_GAP_PER_ACCOUNT_MS, publishDuePosts, type PublishDeps } from '../src/publisher';
import { keyringFrom } from '../src/tokenVault';
import { createTestDb, dropTestDb } from './dbTestHelper';

const ring = keyringFrom([['v1', randomBytes(32)]]);
const IG_USER = '17841400123456789';
const T0 = new Date('2026-10-05T09:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/**
 * A stand-in for graph.instagram.com that keeps state the way the real one
 * does: containers transcode over a few polls, publishing a container twice
 * fails, and any step can be made to fail in the ways Meta's can.
 */
function fakeInstagram(options: {
  quotaLeft?: number;
  pollsUntilFinished?: number;
  containerResult?: 'FINISHED' | 'ERROR';
  failCreate?: { status: number; body: string };
  /** The publish call succeeds on Instagram's side, but the answer is lost. */
  loseFirstPublishAnswer?: boolean;
} = {}) {
  const calls: Array<{ method: string; url: string; auth: string | null; body: string }> = [];
  const containers = new Map<string, { polls: number; published: boolean }>();
  let publishCalls = 0;
  let lostOne = false;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url, auth: headers.get('Authorization'), body: init?.body ? String(init.body) : '' });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (url.includes('/content_publishing_limit')) {
      return json({ data: [{ quota_usage: 100 - (options.quotaLeft ?? 50), config: { quota_total: 100 } }] });
    }
    if (method === 'POST' && url.endsWith(`/${IG_USER}/media`)) {
      if (options.failCreate) return new Response(options.failCreate.body, { status: options.failCreate.status });
      const id = `c${containers.size + 1}`;
      containers.set(id, { polls: 0, published: false });
      return json({ id });
    }
    if (method === 'POST' && url.endsWith(`/${IG_USER}/media_publish`)) {
      publishCalls++;
      const id = new URLSearchParams(String(init?.body)).get('creation_id')!;
      const c = containers.get(id)!;
      if (c.published) return json({ error: { code: 9007, message: 'already published' } }, 400);
      c.published = true;
      if (options.loseFirstPublishAnswer && !lostOne) {
        lostOne = true;
        throw new TypeError('fetch failed');
      }
      return json({ id: `media-${id}` });
    }
    const status = url.match(/\/(c\d+)\?fields=status_code/);
    if (status) {
      const c = containers.get(status[1])!;
      if (c.published) return json({ status_code: 'PUBLISHED' });
      c.polls++;
      const done = c.polls > (options.pollsUntilFinished ?? 1);
      return json({ status_code: done ? options.containerResult ?? 'FINISHED' : 'IN_PROGRESS', status: done && options.containerResult === 'ERROR' ? 'Error: video too long' : '' });
    }
    const permalink = url.match(/\/(media-c\d+)\?fields=permalink/);
    if (permalink) return json({ permalink: `https://www.instagram.com/reel/${permalink[1]}/` });
    return json({ error: { message: `unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;

  return { fetchImpl, calls, containers, publishCalls: () => publishCalls };
}

describe('publishing to Instagram', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);
    const account = await saveConnectedAccount(db, ring, 't1', 'instagram', {
      userId: IG_USER,
      username: 'blogger',
      accessToken: 'IGAA-secret-token',
      expiresAt: at(50 * 24 * 3600 * 1000),
    });
    accountId = account.id;
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function post(id: string, scheduledAt = T0, account: string | null = accountId) {
    await exec(
      db,
      `INSERT INTO scheduled_posts (id, tenant_id, platform, caption, scheduled_at, status, video_object_key, platform_account_id)
       VALUES (?, 't1', 'instagram', 'Подпись #тег', ?, 'scheduled', 'tenants/t1/renders/x.mp4', ?)`,
      id,
      scheduledAt.toISOString(),
      account
    );
  }
  const row = (id: string) => queryOne<Record<string, unknown>>(db, `SELECT * FROM scheduled_posts WHERE id = ?`, id);
  const deps = (fake: ReturnType<typeof fakeInstagram>): PublishDeps => ({
    keyring: ring,
    fetchImpl: fake.fetchImpl,
    videoUrl: (key) => `https://storage.example/${key}?signed=1`,
  });

  it('creates a container, waits for Instagram to transcode, then publishes once', async () => {
    const fake = fakeInstagram({ pollsUntilFinished: 1 });
    await post('p1');

    await publishDuePosts(db, at(0), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'publishing', publish_stage: 'container', ig_container_id: 'c1', claimed_at: null });
    const create = fake.calls.find((c) => c.url.endsWith('/media'))!;
    expect(Object.fromEntries(new URLSearchParams(create.body))).toMatchObject({
      media_type: 'REELS',
      video_url: 'https://storage.example/tenants/t1/renders/x.mp4?signed=1',
      caption: 'Подпись #тег',
    });

    // Too early: nothing is due yet.
    expect((await publishDuePosts(db, at(5_000), undefined, deps(fake))).processed).toBe(0);
    // Still transcoding: released for another look.
    await publishDuePosts(db, at(20_000), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'publishing', claimed_at: null });
    // Finished: published.
    await publishDuePosts(db, at(40_000), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'published', external_post_url: 'https://www.instagram.com/reel/media-c1/' });
    expect(fake.publishCalls()).toBe(1);
  });

  // The one failure that must never happen: a reel on someone's profile twice.
  it('does not publish twice when the answer to the publish call was lost', async () => {
    const fake = fakeInstagram({ pollsUntilFinished: 0, loseFirstPublishAnswer: true });
    await post('p1');
    await publishDuePosts(db, at(0), undefined, deps(fake));
    await publishDuePosts(db, at(20_000), undefined, deps(fake)); // publish — answer lost
    expect(await row('p1')).toMatchObject({ status: 'publishing', publish_stage: 'publishing' });

    await publishDuePosts(db, at(200_000), undefined, deps(fake)); // retry finds it PUBLISHED
    expect(await row('p1')).toMatchObject({ status: 'published' });
    expect(fake.publishCalls()).toBe(1);
  });

  it('keeps its own pace: two reels to one account are spaced out', async () => {
    const fake = fakeInstagram();
    await post('p1');
    await post('p2');
    await publishDuePosts(db, at(0), undefined, deps(fake));

    const containers = await queryAll<{ id: string }>(db, `SELECT id FROM scheduled_posts WHERE ig_container_id IS NOT NULL`);
    expect(containers).toHaveLength(1);
    const waiting = (await row(containers[0].id === 'p1' ? 'p2' : 'p1'))!;
    expect(waiting).toMatchObject({ status: 'publishing', waiting_reason: 'pace' });
    expect(new Date(waiting.next_attempt_at as string).getTime()).toBe(T0.getTime() + MIN_GAP_PER_ACCOUNT_MS);
  });

  it('waits out Instagram\'s daily limit instead of failing', async () => {
    const fake = fakeInstagram({ quotaLeft: 0 });
    await post('p1');
    await publishDuePosts(db, at(0), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'publishing', waiting_reason: 'instagram_limit', ig_container_id: null });
    expect(fake.calls.some((c) => c.url.endsWith('/media'))).toBe(false);
  });

  it('asks for a reconnect when Instagram says the token is dead', async () => {
    const fake = fakeInstagram({ failCreate: { status: 400, body: JSON.stringify({ error: { code: 190, message: 'expired' } }) } });
    await post('p1');
    await publishDuePosts(db, at(0), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'failed', failure_reason: 'token_expired' });
    expect((await queryOne<{ status: string }>(db, `SELECT status FROM platform_accounts`))!.status).toBe('needs_reconnect');
  });

  it('says in Instagram\'s own words why it refused a post', async () => {
    const fake = fakeInstagram({
      failCreate: { status: 400, body: JSON.stringify({ error: { code: 36003, message: 'x', error_user_msg: 'Видео должно быть не длиннее 15 минут' } }) },
    });
    await post('p1');
    await publishDuePosts(db, at(0), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'failed', failure_reason: 'rejected_by_platform', failure_detail: 'Видео должно быть не длиннее 15 минут' });
  });

  it('fails a reel Instagram could not transcode', async () => {
    const fake = fakeInstagram({ pollsUntilFinished: 0, containerResult: 'ERROR' });
    await post('p1');
    await publishDuePosts(db, at(0), undefined, deps(fake));
    await publishDuePosts(db, at(20_000), undefined, deps(fake));
    expect(await row('p1')).toMatchObject({ status: 'failed', failure_reason: 'processing_failed' });
    expect(fake.publishCalls()).toBe(0);
  });

  it('retries Meta\'s bad minutes with growing gaps, then gives up', async () => {
    const fake = fakeInstagram({ failCreate: { status: 503, body: 'unavailable' } });
    await post('p1');
    let clock = 0;
    for (let i = 0; i < 5; i++) {
      await publishDuePosts(db, at(clock), undefined, deps(fake));
      const r = (await row('p1'))!;
      if (r.status === 'failed') break;
      clock = new Date(r.next_attempt_at as string).getTime() - T0.getTime();
    }
    expect(await row('p1')).toMatchObject({ status: 'failed', failure_reason: 'publish_failed' });
    // 1, 2, 4, 8 minutes apart before the fifth attempt.
    expect(clock).toBe((1 + 2 + 4 + 8) * 60_000);
  });

  it('never puts the token in a URL', async () => {
    const fake = fakeInstagram({ pollsUntilFinished: 0 });
    await post('p1');
    await publishDuePosts(db, at(0), undefined, deps(fake));
    await publishDuePosts(db, at(20_000), undefined, deps(fake));
    expect(fake.calls.length).toBeGreaterThan(3);
    for (const call of fake.calls) {
      expect(call.url).not.toContain('IGAA-secret-token');
      expect(call.auth).toBe('Bearer IGAA-secret-token');
    }
  });

  it('uses the mock for a test account or no account, and fails a post whose account is gone', async () => {
    const fake = fakeInstagram();
    await exec(db, `UPDATE platform_accounts SET is_test = true`);
    await post('p-test');
    await post('p-none', T0, null);
    await post('p-gone', T0, 'deleted-account');
    await publishDuePosts(db, at(0), undefined, deps(fake));

    expect(fake.calls).toHaveLength(0);
    expect((await row('p-test'))!.status).not.toBe('publishing');
    expect((await row('p-none'))!.status).not.toBe('publishing');
    expect(await row('p-gone')).toMatchObject({ status: 'failed', failure_reason: 'account_unavailable' });
  });
});

describe('classifyGraphError', () => {
  it('sorts Meta\'s errors by what to do about them', () => {
    expect(classifyGraphError(400, '{"error":{"code":190}}').kind).toBe('token_invalid');
    expect(classifyGraphError(400, '{"error":{"code":4}}').kind).toBe('rate_limited');
    expect(classifyGraphError(400, '{"error":{"code":9,"error_subcode":2207042}}').kind).toBe('rate_limited');
    expect(classifyGraphError(500, 'oops').kind).toBe('transient');
    expect(classifyGraphError(400, '{"error":{"code":100,"message":"bad"}}').kind).toBe('rejected');
  });
});

describe('choosing the account for a post', () => {
  let db: Db;
  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  it('takes only this workspace\'s working account for the same platform', async () => {
    const app = createApp(db, { tokenKeyring: ring, instagram: null });
    const make = async (email: string) => {
      const res = await request(app).post('/api/tenants').send({ name: 'B', email });
      return { auth: `Bearer ${res.body.apiKey}`, id: res.body.tenant.id as string };
    };
    const a = await make('a-acc@example.com');
    const b = await make('b-acc@example.com');
    const mine = await saveConnectedAccount(db, ring, a.id, 'instagram', { userId: '1', username: 'a', accessToken: 't', expiresAt: at(9e9) });
    const theirs = await saveConnectedAccount(db, ring, b.id, 'instagram', { userId: '2', username: 'b', accessToken: 't', expiresAt: at(9e9) });
    const send = (fields: Record<string, unknown>) =>
      request(app)
        .post('/api/scheduled-posts')
        .set('Authorization', a.auth)
        .send({ platform: 'instagram', caption: 'x', scheduledAt: T0.toISOString(), videoObjectKey: `tenants/${a.id}/sources/v.mp4`, ...fields });

    expect((await send({ platformAccountId: theirs.id })).status).toBe(404);
    expect((await send({ platformAccountId: mine.id, platform: 'tiktok' })).status).toBe(400);
    await exec(db, `UPDATE platform_accounts SET status = 'needs_reconnect' WHERE id = ?`, mine.id);
    expect((await send({ platformAccountId: mine.id })).status).toBe(409);
    await exec(db, `UPDATE platform_accounts SET status = 'active' WHERE id = ?`, mine.id);

    const ok = await send({ platformAccountId: mine.id });
    expect(ok.status).toBe(201);
    expect(ok.body.post.platform_account_id).toBe(mine.id);
    expect(ok.body.post).not.toHaveProperty('ig_container_id');
  });
});
