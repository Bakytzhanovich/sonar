import type Database from 'better-sqlite3';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

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
export function createApiKeyForTenant(db: Database.Database, tenantId: string): string {
  const rawKey = generateApiKey();
  db.prepare(`INSERT INTO api_keys (id, tenant_id, key_hash) VALUES (?, ?, ?)`).run(
    randomUUID(),
    tenantId,
    hashApiKey(rawKey)
  );
  return rawKey;
}

export function resolveTenantIdFromApiKey(db: Database.Database, rawKey: string): string | undefined {
  const row = db.prepare(`SELECT tenant_id FROM api_keys WHERE key_hash = ?`).get(hashApiKey(rawKey)) as
    | { tenant_id: string }
    | undefined;
  return row?.tenant_id;
}
