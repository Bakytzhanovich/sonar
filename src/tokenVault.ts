import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './auth';

// Platform access tokens, encrypted at rest (CLAUDE.md, security section).
//
// A connected account's token can publish to someone's Instagram. A database
// dump — a backup left readable, a leaked replica — must not be enough to do
// that, so the token is stored only as ciphertext, and the key lives outside
// the database, in the environment.
//
// AES-256-GCM: authenticated, so a ciphertext that was tampered with fails to
// decrypt instead of decrypting to garbage. Each encryption is bound to an
// "associated data" string naming the row it belongs to. A ciphertext copied
// into another tenant's row then fails too — the database alone cannot be
// used to move one client's access to another.
//
// Rotation: the key is a ring of versions, newest first. New ciphertext is
// always made with the newest; old ciphertext names its version and still
// decrypts until it is re-encrypted (see needsReencryption). Retiring a key
// is: add the new one in front, let the sweep re-encrypt, then drop the old.
//
// The ring is the one seam a cloud KMS would replace later — nothing else in
// the code knows where the key bytes come from.

export interface TokenKeyring {
  /** The version new ciphertext is made with. */
  current: { id: string; key: Buffer };
  get(id: string): Buffer | undefined;
}

export class TokenVaultError extends Error {
  constructor(readonly reason: 'vault_not_configured' | 'unknown_key' | 'cannot_decrypt' | 'bad_key_config') {
    super(reason);
    this.name = 'TokenVaultError';
  }
}

const KEY_ID = /^[a-z0-9]{1,16}$/;

/**
 * Reads `TOKEN_ENCRYPTION_KEYS`: comma-separated `id:base64key`, newest first,
 * each key exactly 32 bytes. Generate one with
 * `node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"`.
 *
 * Outside production, with nothing set, falls back to a key derived from
 * SESSION_SECRET so development and tests work without setup. Never in
 * production: there the session secret and the token key must be separate,
 * or rotating one would destroy the other.
 *
 * Returns null in production when unset. The server still boots — refusing
 * to would take the whole product down over one feature — and connecting an
 * account answers "not configured" instead.
 */
export function keyringFromEnv(
  raw: string | undefined = process.env.TOKEN_ENCRYPTION_KEYS,
  production: boolean = process.env.NODE_ENV === 'production'
): TokenKeyring | null {
  if (!raw || !raw.trim()) {
    if (production) return null;
    return keyringFrom([['dev', Buffer.from(deriveKey('token-vault'), 'hex')]]);
  }
  const entries = raw.split(',').map((part) => {
    const at = part.indexOf(':');
    const id = part.slice(0, at).trim();
    const key = Buffer.from(part.slice(at + 1).trim(), 'base64');
    // Loud: a mistyped key would otherwise encrypt with something nobody can
    // reproduce, and every token saved with it would be lost on restart.
    if (at < 1 || !KEY_ID.test(id) || key.length !== 32) throw new TokenVaultError('bad_key_config');
    return [id, key] as [string, Buffer];
  });
  return keyringFrom(entries);
}

export function keyringFrom(entries: Array<[string, Buffer]>): TokenKeyring {
  if (entries.length === 0) throw new TokenVaultError('bad_key_config');
  const byId = new Map(entries);
  if (byId.size !== entries.length) throw new TokenVaultError('bad_key_config');
  return { current: { id: entries[0][0], key: entries[0][1] }, get: (id) => byId.get(id) };
}

/** `version:iv:tag:ciphertext`, base64 parts. Text, so it fits a TEXT column. */
export function encryptToken(ring: TokenKeyring, plaintext: string, boundTo: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, iv);
  cipher.setAAD(Buffer.from(boundTo, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ring.current.id, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function decryptToken(ring: TokenKeyring, sealed: string, boundTo: string): string {
  const [id, iv, tag, body] = sealed.split(':');
  const key = ring.get(id ?? '');
  if (!key) throw new TokenVaultError('unknown_key');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv ?? '', 'base64'));
    decipher.setAAD(Buffer.from(boundTo, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag ?? '', 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body ?? '', 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // No detail: whatever went wrong, the answer is the same, and an error
    // message is the last place a fragment of a secret should end up.
    throw new TokenVaultError('cannot_decrypt');
  }
}

/** True when the ciphertext was made with a key that is no longer the newest. */
export function needsReencryption(ring: TokenKeyring, sealed: string): boolean {
  return sealed.split(':')[0] !== ring.current.id;
}

/** What a platform account's token is bound to. One place, so the writer and
 *  the reader cannot disagree about it. */
export function accountTokenBinding(account: { id: string; tenant_id: string; platform: string }): string {
  return `platform_account:${account.tenant_id}:${account.platform}:${account.id}`;
}
