import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'node:crypto';

// Falls back to a fixed dev secret only under vitest (which sets
// NODE_ENV=test itself), so `npm test` works with no setup. Any other
// environment — including `npm run dev` — must set SESSION_SECRET (e.g. in
// .env, loaded via --env-file-if-exists). Gating on NODE_ENV==='production'
// used to be the check here, but plenty of real deployments (plain Docker,
// PM2, a bare `node dist/server.js`) never explicitly set NODE_ENV at all,
// so that check silently accepted the hardcoded fallback in production too
// — see CLAUDE.md's security section (secrets belong in Vault/AWS Secrets
// Manager, never in code). Deploying without SESSION_SECRET set is a real
// vulnerability (anyone can forge a session for any tenant), so this fails
// loudly by default instead of silently accepting the dev fallback.
const SESSION_SECRET = requireSessionSecret();

function requireSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'test') {
    return 'dev-insecure-secret-change-in-production';
  }
  throw new Error('SESSION_SECRET must be set (see .env) — refusing to sign sessions with a guessable default');
}

// Derives a purpose-scoped key from the session secret, so a subsystem that
// needs to sign something (local media URLs) never receives the secret that
// signs sessions. A leak of one derived key cannot be turned into a forged
// session, and two subsystems can never accidentally accept each other's
// tokens.
export function deriveKey(purpose: string): string {
  return createHmac('sha256', SESSION_SECRET).update(`sonar:${purpose}`).digest('hex');
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Cost factor 12 — bcrypt's own recommended floor as of 2024+ hardware; a
// human-chosen password (unlike apiKeys.ts's high-entropy random token)
// needs a deliberately slow, salted hash to resist offline brute-forcing.
const BCRYPT_COST = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// A real bcrypt hash (of an unguessable random string) for the login route
// to compare against when no user matched the submitted email. Verifying
// against this costs the same ~100ms as verifying a genuine user's hash,
// which is what keeps "no such account" and "wrong password" — already
// identical in their response bodies — also identical in response time.
// Generated once at module load rather than hardcoded so no fixed hash of
// a known value ever ships in the repository.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

export interface SessionPayload {
  userId: string;
  tenantId: string;
}

// ttlSeconds defaults to the real 7-day session lifetime; tests pass a
// negative value to produce an already-expired token synchronously instead
// of sleeping past a real expiry.
export function signSession(payload: SessionPayload, ttlSeconds: number = SESSION_TTL_SECONDS): string {
  return jwt.sign(payload, SESSION_SECRET, { expiresIn: ttlSeconds });
}

export type SessionVerifyResult = { ok: true; payload: SessionPayload } | { ok: false; reason: 'expired' | 'invalid' };

// Distinguishes "expired" from "invalid" so the frontend can show "your
// session expired, log in again" instead of a generic auth error — and so
// the expired-session test case the plan calls for actually has something
// specific to assert on.
export function verifySession(token: string): SessionVerifyResult {
  try {
    const decoded = jwt.verify(token, SESSION_SECRET);
    if (typeof decoded === 'string' || typeof decoded.userId !== 'string' || typeof decoded.tenantId !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, payload: { userId: decoded.userId, tenantId: decoded.tenantId } };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}
