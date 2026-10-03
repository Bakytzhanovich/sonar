import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { exec, queryAll, queryOne, type Db } from '../src/db';
import { createApp } from '../src/api';
import {
  accountTokenBinding,
  decryptToken,
  encryptToken,
  keyringFrom,
  keyringFromEnv,
  needsReencryption,
  TokenVaultError,
} from '../src/tokenVault';
import { authorizeUrl, connectWithCode, readUserId, signState, verifyState, type InstagramAppConfig } from '../src/instagramAuth';
import { maintainTokens, openToken, saveConnectedAccount, type PlatformAccountRow } from '../src/platformAccounts';
import { requiredRole } from '../src/roles';
import { createTestDb, dropTestDb } from './dbTestHelper';

const key = () => randomBytes(32);
const IG: InstagramAppConfig = { appId: 'app-123', appSecret: 'app-secret-xyz', redirectUri: 'https://sonar.example/api/oauth/instagram/callback' };
// Bigger than Number.MAX_SAFE_INTEGER: JSON.parse would round it.
const BIG_ID = '17841400123456789';

describe('token vault', () => {
  const ring = keyringFrom([['v1', key()]]);

  it('seals and opens a token, and the sealed form does not contain it', () => {
    const sealed = encryptToken(ring, 'IGQVJ-secret-token', 'row-a');
    expect(sealed).not.toContain('IGQVJ');
    expect(decryptToken(ring, sealed, 'row-a')).toBe('IGQVJ-secret-token');
  });

  it('refuses a tampered token', () => {
    const sealed = encryptToken(ring, 'token', 'row-a');
    const parts = sealed.split(':');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 1;
    parts[3] = body.toString('base64');
    expect(() => decryptToken(ring, parts.join(':'), 'row-a')).toThrow(TokenVaultError);
  });

  // The point of the binding: a token copied into another workspace's row
  // in the database is useless there.
  it('refuses a token moved to another row', () => {
    const sealed = encryptToken(ring, 'token', accountTokenBinding({ id: 'a1', tenant_id: 't1', platform: 'instagram' }));
    expect(() => decryptToken(ring, sealed, accountTokenBinding({ id: 'a1', tenant_id: 't2', platform: 'instagram' }))).toThrow(TokenVaultError);
  });

  it('keeps old tokens readable through a key rotation, and says which need re-sealing', () => {
    const v1 = key();
    const old = keyringFrom([['v1', v1]]);
    const sealed = encryptToken(old, 'token', 'row');
    const rotated = keyringFrom([['v2', key()], ['v1', v1]]);
    expect(decryptToken(rotated, sealed, 'row')).toBe('token');
    expect(needsReencryption(rotated, sealed)).toBe(true);
    expect(needsReencryption(rotated, encryptToken(rotated, 'token', 'row'))).toBe(false);
    // Once v1 is dropped, what was not re-sealed is gone — loudly.
    expect(() => decryptToken(keyringFrom([['v2', key()]]), sealed, 'row')).toThrow('unknown_key');
  });

  it('reads keys from the environment, newest first, and refuses a malformed one', () => {
    const ring2 = keyringFromEnv(`v2:${key().toString('base64')},v1:${key().toString('base64')}`, true)!;
    expect(ring2.current.id).toBe('v2');
    expect(ring2.get('v1')).toBeDefined();
    expect(() => keyringFromEnv('v1:dG9vLXNob3J0', true)).toThrow('bad_key_config');
    expect(() => keyringFromEnv(`v1:${key().toString('base64')},v1:${key().toString('base64')}`, true)).toThrow('bad_key_config');
  });

  it('has no key in production unless one is set, and a derived one in development', () => {
    expect(keyringFromEnv(undefined, true)).toBeNull();
    expect(keyringFromEnv(undefined, false)?.current.id).toBe('dev');
  });
});

describe('instagram auth', () => {
  it('keeps a user id that a JavaScript number would round', () => {
    expect(readUserId(`{"user_id": ${BIG_ID}, "username": "x"}`)).toBe(BIG_ID);
    expect(readUserId(`{"data":[{"user_id":"${BIG_ID}"}]}`)).toBe(BIG_ID);
  });

  it('accepts its own state, and refuses a forged or an old one', () => {
    const now = new Date('2026-10-03T10:00:00Z');
    const state = signState('secret', 'tenant-1', now);
    expect(verifyState('secret', state, now)).toBe('tenant-1');
    expect(verifyState('other-secret', state, now)).toBeNull();
    expect(verifyState('secret', state, new Date(now.getTime() + 11 * 60 * 1000))).toBeNull();
    const [payload, mac] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'tenant-2', e: now.getTime() + 60_000, n: 'x' })).toString('base64url');
    expect(verifyState('secret', `${forged}.${mac}`, now)).toBeNull();
    expect(verifyState('secret', payload, now)).toBeNull();
  });

  it('asks for publishing and the profile, nothing more', () => {
    const url = new URL(authorizeUrl(IG, 'st'));
    expect(url.origin).toBe('https://www.instagram.com');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_content_publish');
    expect(url.searchParams.get('redirect_uri')).toBe(IG.redirectUri);
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('turns a code into a 60-day token and a profile', async () => {
    const { fetchImpl, calls } = fakeInstagram();
    const now = new Date('2026-10-03T10:00:00Z');
    const profile = await connectWithCode(IG, 'the-code#_', fetchImpl, now);

    expect(profile).toMatchObject({ userId: BIG_ID, username: 'blogger', accessToken: 'long-token' });
    expect(profile.expiresAt.getTime() - now.getTime()).toBe(5_184_000 * 1000);
    // The "#_" Instagram appends is not part of the code.
    expect(new URLSearchParams(String(calls[0].init?.body)).get('code')).toBe('the-code');
  });
});

/** A stand-in for Instagram's three token endpoints and the profile read. */
function fakeInstagram(options: { refreshFails?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.instagram.com/oauth/access_token')) return json(`{"data":[{"access_token":"short-token","user_id":${BIG_ID},"permissions":"x"}]}`);
    if (url.startsWith('https://graph.instagram.com/access_token')) return json('{"access_token":"long-token","token_type":"bearer","expires_in":5184000}');
    if (url.startsWith('https://graph.instagram.com/refresh_access_token')) {
      return options.refreshFails ? json('{"error":{"message":"nope"}}', 400) : json('{"access_token":"renewed-token","token_type":"bearer","expires_in":5184000}');
    }
    if (url.includes('/me?')) return json(`{"user_id":"${BIG_ID}","username":"blogger","id":"${BIG_ID}"}`);
    return json('{}', 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('connected accounts API', () => {
  let db: Db;
  const ring = keyringFrom([['v1', key()]]);

  beforeEach(async () => { db = await createTestDb(); });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function tenant(app: Express, email: string) {
    const res = await request(app).post('/api/tenants').send({ name: 'Blogger', email });
    return { apiKey: res.body.apiKey as string, id: res.body.tenant.id as string };
  }

  it('says connecting is not available yet, rather than failing on the click', async () => {
    const app = createApp(db, { tokenKeyring: ring, instagram: null });
    const t = await tenant(app, 'na@example.com');
    const list = await request(app).get('/api/platform-accounts').set('Authorization', `Bearer ${t.apiKey}`);
    expect(list.body).toMatchObject({ accounts: [], instagramAvailable: false });
    const connect = await request(app).post('/api/platform-accounts/instagram/connect').set('Authorization', `Bearer ${t.apiKey}`);
    expect(connect.status).toBe(503);
  });

  it('will not connect anything without an encryption key', async () => {
    const app = createApp(db, { tokenKeyring: null, instagram: IG });
    const t = await tenant(app, 'nokey@example.com');
    const connect = await request(app).post('/api/platform-accounts/instagram/connect').set('Authorization', `Bearer ${t.apiKey}`);
    expect(connect.body.error).toBe('token_vault_not_configured');
  });

  it('connects an account end to end, storing only ciphertext', async () => {
    const { fetchImpl } = fakeInstagram();
    const app = createApp(db, { tokenKeyring: ring, instagram: IG, instagramFetch: fetchImpl });
    const t = await tenant(app, 'ig@example.com');

    const start = await request(app).post('/api/platform-accounts/instagram/connect').set('Authorization', `Bearer ${t.apiKey}`);
    const state = new URL(start.body.authorizeUrl).searchParams.get('state');
    const back = await request(app).get(`/api/oauth/instagram/callback?code=abc%23_&state=${encodeURIComponent(state!)}`);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe('/scheduler?instagram=connected');

    const row = (await queryOne<PlatformAccountRow>(db, `SELECT * FROM platform_accounts WHERE tenant_id = ?`, t.id))!;
    expect(row.external_user_id).toBe(BIG_ID);
    expect(row.token_ciphertext).not.toContain('long-token');
    expect(openToken(ring, row)).toBe('long-token');

    const list = await request(app).get('/api/platform-accounts').set('Authorization', `Bearer ${t.apiKey}`);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0]).toMatchObject({ platform: 'instagram', username: 'blogger', status: 'active' });
    expect(JSON.stringify(list.body)).not.toMatch(/token_ciphertext|long-token|external_user_id/);
  });

  it('reconnecting the same Instagram renews the one row instead of adding another', async () => {
    const { fetchImpl } = fakeInstagram();
    const app = createApp(db, { tokenKeyring: ring, instagram: IG, instagramFetch: fetchImpl });
    const t = await tenant(app, 'again@example.com');
    for (let i = 0; i < 2; i++) {
      const start = await request(app).post('/api/platform-accounts/instagram/connect').set('Authorization', `Bearer ${t.apiKey}`);
      const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
      await request(app).get(`/api/oauth/instagram/callback?code=c${i}&state=${encodeURIComponent(state)}`);
    }
    await exec(db, `UPDATE platform_accounts SET status = 'needs_reconnect'`);
    const start = await request(app).post('/api/platform-accounts/instagram/connect').set('Authorization', `Bearer ${t.apiKey}`);
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    await request(app).get(`/api/oauth/instagram/callback?code=c3&state=${encodeURIComponent(state)}`);

    const rows = await queryAll<PlatformAccountRow>(db, `SELECT * FROM platform_accounts`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    // Re-sealed for the row that was already there, so it still opens.
    expect(openToken(ring, rows[0])).toBe('long-token');
  });

  it('sends the person back with a reason when the connection did not happen', async () => {
    const { fetchImpl, calls } = fakeInstagram();
    const app = createApp(db, { tokenKeyring: ring, instagram: IG, instagramFetch: fetchImpl });
    const denied = await request(app).get('/api/oauth/instagram/callback?error=access_denied&state=x');
    expect(denied.headers.location).toBe('/scheduler?instagram=denied');
    const forged = await request(app).get('/api/oauth/instagram/callback?code=c&state=made.up');
    expect(forged.headers.location).toBe('/scheduler?instagram=expired');
    // A forged state never reaches Instagram with our app secret.
    expect(calls).toHaveLength(0);
  });

  it('disconnects only the caller\'s own account', async () => {
    const app = createApp(db, { tokenKeyring: ring, instagram: null });
    const owner = await tenant(app, 'own@example.com');
    const other = await tenant(app, 'other@example.com');
    const made = await request(app).post('/api/platform-accounts/test').set('Authorization', `Bearer ${owner.apiKey}`);
    expect(made.status).toBe(201);
    expect(made.body.account).toMatchObject({ username: 'test_blogger', is_test: true });

    const theirs = await request(app).delete(`/api/platform-accounts/${made.body.account.id}`).set('Authorization', `Bearer ${other.apiKey}`);
    expect(theirs.status).toBe(404);
    const mine = await request(app).delete(`/api/platform-accounts/${made.body.account.id}`).set('Authorization', `Bearer ${owner.apiKey}`);
    expect(mine.status).toBe(204);
    expect(await queryAll(db, `SELECT id FROM platform_accounts`)).toHaveLength(0);
  });

  it('lets everyone see the accounts but only an owner change them', () => {
    expect(requiredRole('GET', '/api/platform-accounts')).toBe('viewer');
    expect(requiredRole('POST', '/api/platform-accounts/instagram/connect')).toBe('owner');
    expect(requiredRole('DELETE', '/api/platform-accounts/abc')).toBe('owner');
  });
});

describe('token upkeep', () => {
  let db: Db;
  const ring = keyringFrom([['v1', key()]]);
  const now = new Date('2026-10-03T10:00:00Z');
  const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

  beforeEach(async () => {
    db = await createTestDb();
    await exec(db, `INSERT INTO tenants (id, name, email) VALUES ('t1', 'T', 't@example.com')`);
  });
  afterEach(async () => { if (db) await dropTestDb(db); });

  async function account(expiresAt: Date, connectedAt: Date, userId = BIG_ID, keyring = ring) {
    await saveConnectedAccount(db, keyring, 't1', 'instagram', { userId, username: 'blogger', accessToken: 'old-token', expiresAt });
    await exec(db, `UPDATE platform_accounts SET connected_at = ? WHERE external_user_id = ?`, connectedAt.toISOString(), userId);
  }

  it('renews a token a few days before it runs out', async () => {
    await account(days(3), days(-57));
    const { fetchImpl } = fakeInstagram();
    const result = await maintainTokens(db, ring, now, fetchImpl);

    expect(result.refreshed).toBe(1);
    const row = (await queryOne<PlatformAccountRow>(db, `SELECT * FROM platform_accounts`))!;
    expect(openToken(ring, row)).toBe('renewed-token');
    expect(new Date(row.token_expires_at!).getTime()).toBe(now.getTime() + 5_184_000 * 1000);
  });

  it('leaves alone a token with weeks left, or one too young to renew', async () => {
    await account(days(40), days(-20), '1');
    await account(days(3), new Date(now.getTime() - 60 * 60 * 1000), '2');
    const { fetchImpl, calls } = fakeInstagram();
    expect((await maintainTokens(db, ring, now, fetchImpl)).refreshed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('asks the person to reconnect once a token cannot be saved, and tells them', async () => {
    await account(days(-1), days(-61));
    const result = await maintainTokens(db, ring, now, fakeInstagram().fetchImpl);

    expect(result.needsReconnect).toBe(1);
    expect((await queryOne<{ status: string }>(db, `SELECT status FROM platform_accounts`))!.status).toBe('needs_reconnect');
    const notes = await queryAll<{ type: string; message: string }>(db, `SELECT type, message FROM notifications WHERE tenant_id = 't1'`);
    expect(notes).toEqual([expect.objectContaining({ type: 'account_needs_reconnect', message: expect.stringContaining('@blogger') })]);
  });

  it('keeps trying while there is time, and gives up only on the last day', async () => {
    await account(days(3), days(-57), '1');
    await account(new Date(now.getTime() + 6 * 60 * 60 * 1000), days(-60), '2');
    const result = await maintainTokens(db, ring, now, fakeInstagram({ refreshFails: true }).fetchImpl);

    const rows = await queryAll<{ external_user_id: string; status: string }>(db, `SELECT external_user_id, status FROM platform_accounts ORDER BY external_user_id`);
    expect(rows).toEqual([
      { external_user_id: '1', status: 'active' },
      { external_user_id: '2', status: 'needs_reconnect' },
    ]);
    expect(result.needsReconnect).toBe(1);
  });

  it('re-seals tokens under the newest key after a rotation', async () => {
    const v1 = key();
    const old = keyringFrom([['v1', v1]]);
    await account(days(40), days(-20), BIG_ID, old);
    const rotated = keyringFrom([['v2', key()], ['v1', v1]]);

    expect((await maintainTokens(db, rotated, now, fakeInstagram().fetchImpl)).reencrypted).toBe(1);
    const row = (await queryOne<PlatformAccountRow>(db, `SELECT * FROM platform_accounts`))!;
    expect(row.token_ciphertext.startsWith('v2:')).toBe(true);
    expect(openToken(keyringFrom([['v2', rotated.current.key]]), row)).toBe('old-token');
  });
});
