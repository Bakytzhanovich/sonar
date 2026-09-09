import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { exec, queryOne, type Db } from './db';

// Random 256-bit token, not a password — SHA-256 is the right hash here
// (no salt/slow-KDF needed, unlike bcrypt for user passwords), because
// brute-forcing a uniformly random 32-byte value is infeasible regardless
// of hash speed.
export function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// Returns the raw key — caller must show it to the user now, it can never
// be recovered again (only its hash is stored).
export async function createApiKeyForTenant(db: Db, tenantId: string): Promise<string> {
  const rawKey = generateApiKey();
  await exec(db, `INSERT INTO api_keys (id, tenant_id, key_hash) VALUES (?, ?, ?)`, randomUUID(), tenantId, hashApiKey(rawKey));
  return rawKey;
}

export async function resolveTenantIdFromApiKey(db: Db, rawKey: string): Promise<string | undefined> {
  const row = await queryOne<{ tenant_id: string }>(db, `SELECT tenant_id FROM api_keys WHERE key_hash = ?`, hashApiKey(rawKey));
  return row?.tenant_id;
}
