import { randomUUID } from 'node:crypto';
import { exec, queryAll, queryOne, type Db } from './db';
import { refreshLongLived, type ConnectedProfile } from './instagramAuth';
import { notify } from './notifications';
import { accountTokenBinding, decryptToken, encryptToken, needsReencryption, type TokenKeyring } from './tokenVault';

// Module 5 — the social accounts a workspace has connected, and the upkeep of
// their tokens. The only module that ever holds a decrypted token, and only
// for the length of one call.

export interface PlatformAccountRow {
  id: string;
  tenant_id: string;
  platform: string;
  external_user_id: string;
  username: string | null;
  token_ciphertext: string;
  token_expires_at: string | null;
  status: 'active' | 'needs_reconnect';
  is_test: boolean;
  connected_at: string;
  refreshed_at: string | null;
}

/** What leaves the server. No token, sealed or not, and no platform user id —
 *  the screen has no use for either. */
export interface PublicPlatformAccount {
  id: string;
  platform: string;
  username: string | null;
  status: 'active' | 'needs_reconnect';
  is_test: boolean;
  token_expires_at: string | null;
  connected_at: string;
}

export function toPublicAccount(row: PlatformAccountRow): PublicPlatformAccount {
  const { id, platform, username, status, is_test, token_expires_at, connected_at } = row;
  return { id, platform, username, status, is_test, token_expires_at, connected_at };
}

export async function listAccounts(db: Db, tenantId: string): Promise<PublicPlatformAccount[]> {
  const rows = await queryAll<PlatformAccountRow>(db, `SELECT * FROM platform_accounts WHERE tenant_id = ? ORDER BY connected_at, seq`, tenantId);
  return rows.map(toPublicAccount);
}

/**
 * Saves a connection, or renews one: connecting the same Instagram again —
 * the usual fix for "needs reconnect" — updates the row in place rather than
 * leaving two.
 *
 * The token is sealed to the row's id, so the id must be known before the
 * token is encrypted. Insert-or-nothing first, then on a conflict seal again
 * for the row that is already there: an upsert with one ciphertext would bind
 * the token to an id the row does not have, and it would never decrypt.
 */
export async function saveConnectedAccount(
  db: Db,
  ring: TokenKeyring,
  tenantId: string,
  platform: string,
  profile: ConnectedProfile & { isTest?: boolean }
): Promise<PublicPlatformAccount> {
  const id = randomUUID();
  const sealed = encryptToken(ring, profile.accessToken, accountTokenBinding({ id, tenant_id: tenantId, platform }));
  const inserted = await queryOne<PlatformAccountRow>(
    db,
    `INSERT INTO platform_accounts (id, tenant_id, platform, external_user_id, username, token_ciphertext, token_expires_at, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, platform, external_user_id) DO NOTHING
     RETURNING *`,
    id,
    tenantId,
    platform,
    profile.userId,
    profile.username,
    sealed,
    profile.isTest ? null : profile.expiresAt.toISOString(),
    Boolean(profile.isTest)
  );
  if (inserted) return toPublicAccount(inserted);

  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM platform_accounts WHERE tenant_id = ? AND platform = ? AND external_user_id = ?`,
    tenantId,
    platform,
    profile.userId
  );
  if (!existing) throw new Error('platform account vanished between insert and update');
  const resealed = encryptToken(ring, profile.accessToken, accountTokenBinding({ id: existing.id, tenant_id: tenantId, platform }));
  const updated = await queryOne<PlatformAccountRow>(
    db,
    `UPDATE platform_accounts
     SET token_ciphertext = ?, token_expires_at = ?, username = COALESCE(?, username), status = 'active', connected_at = now(), refreshed_at = NULL
     WHERE id = ?
     RETURNING *`,
    resealed,
    profile.isTest ? null : profile.expiresAt.toISOString(),
    profile.username,
    existing.id
  );
  return toPublicAccount(updated!);
}

/** The token, for the one call that needs it. Step 3's publisher is the
 *  caller; nothing should keep the result past that call. */
export function openToken(ring: TokenKeyring, row: PlatformAccountRow): string {
  return decryptToken(ring, row.token_ciphertext, accountTokenBinding(row));
}

// ---- Upkeep -----------------------------------------------------------------

/** Renewed this long before expiry. A week, so a few failed attempts in a row
 *  — Meta down for a day, a deploy at the wrong hour — still leave time. */
const REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** Instagram refuses to renew a token younger than a day. */
const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

export interface TokenUpkeepResult {
  refreshed: number;
  needsReconnect: number;
  reencrypted: number;
}

/**
 * Renews tokens that will expire within a week, marks the ones that can no
 * longer be renewed, and re-seals tokens still under a retired key.
 *
 * Marking is for the person, not for us: an expired token can only be
 * replaced by them connecting again, and a post that fails at 3am with
 * "token expired" is a worse way to find out than a notice the day before.
 */
export async function maintainTokens(
  db: Db,
  ring: TokenKeyring,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch
): Promise<TokenUpkeepResult> {
  const result: TokenUpkeepResult = { refreshed: 0, needsReconnect: 0, reencrypted: 0 };

  const due = await queryAll<PlatformAccountRow>(
    db,
    `SELECT * FROM platform_accounts
     WHERE status = 'active' AND is_test = false AND platform = 'instagram'
       AND token_expires_at IS NOT NULL AND token_expires_at < ?`,
    new Date(now.getTime() + REFRESH_AHEAD_MS).toISOString()
  );

  for (const account of due) {
    const expiresAt = new Date(account.token_expires_at!);
    const tooYoung = now.getTime() - new Date(account.refreshed_at ?? account.connected_at).getTime() < MIN_TOKEN_AGE_MS;
    if (expiresAt <= now) {
      await markNeedsReconnect(db, account);
      result.needsReconnect++;
      continue;
    }
    if (tooYoung) continue;
    try {
      const fresh = await refreshLongLived(openToken(ring, account), fetchImpl, now);
      await exec(
        db,
        `UPDATE platform_accounts SET token_ciphertext = ?, token_expires_at = ?, refreshed_at = ? WHERE id = ? AND status = 'active'`,
        encryptToken(ring, fresh.accessToken, accountTokenBinding(account)),
        fresh.expiresAt.toISOString(),
        now.toISOString(),
        account.id
      );
      result.refreshed++;
    } catch (err) {
      // Reason only — the error text of a refresh can never contain the
      // token (instagramAuth keeps URLs out of it), but there is no reason
      // to put more than the reason in a log.
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
      console.warn(`[tokens] ${account.id}: refresh failed (${reason})`);
      // Still time: the next sweep tries again. Less than a day left: say so
      // now, while the person can still reconnect before a post is missed.
      if (expiresAt.getTime() - now.getTime() < MIN_TOKEN_AGE_MS) {
        await markNeedsReconnect(db, account);
        result.needsReconnect++;
      }
    }
  }

  // Rotation: anything sealed under a key that is no longer the newest.
  // Every row is read — there are a handful per workspace, and a column for
  // the key version would be a second place that fact lives.
  const all = await queryAll<PlatformAccountRow>(db, `SELECT * FROM platform_accounts`);
  for (const account of all) {
    if (!needsReencryption(ring, account.token_ciphertext)) continue;
    try {
      const resealed = encryptToken(ring, openToken(ring, account), accountTokenBinding(account));
      // Guarded on the old ciphertext so a refresh that landed meanwhile is
      // not overwritten with the token it replaced.
      await exec(db, `UPDATE platform_accounts SET token_ciphertext = ? WHERE id = ? AND token_ciphertext = ?`, resealed, account.id, account.token_ciphertext);
      result.reencrypted++;
    } catch (err) {
      console.warn(`[tokens] ${account.id}: not re-encrypted (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }

  return result;
}

async function markNeedsReconnect(db: Db, account: PlatformAccountRow): Promise<void> {
  const changed = await queryOne<{ id: string }>(
    db,
    `UPDATE platform_accounts SET status = 'needs_reconnect' WHERE id = ? AND status = 'active' RETURNING id`,
    account.id
  );
  if (!changed) return;
  const who = account.username ? `@${account.username}` : 'Instagram';
  await notify(db, account.tenant_id, 'account_needs_reconnect', `Переподключите ${who}: доступ к аккаунту истекает`, account.id).catch(() => {});
}
