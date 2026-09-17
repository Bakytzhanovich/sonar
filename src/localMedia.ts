import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageIo } from './videoPipeline';

// A filesystem stand-in for S3/R2, so the Level-3 pipeline can be run and
// watched end to end on a laptop with no cloud account.
//
// It deliberately mirrors the real thing rather than bypassing it: uploads and
// downloads go through signed, expiring URLs, exactly like storage.ts's SigV4
// presigning. That keeps one code path through the pipeline and the frontend —
// what you exercise locally is the same flow that will run against R2 — and it
// means a caption <video> tag can load a result without an Authorization
// header it cannot send.
//
// NOT for production. requireLocalMedia() refuses to enable it there unless
// someone opts in explicitly, because the bytes live on a container
// filesystem that is wiped on every deploy.

const DEFAULT_DIR = 'data/media';

export interface LocalMediaConfig {
  root: string;
  // Base URL this API is reachable at, used to build absolute upload/download
  // URLs for the browser. Relative URLs would break as soon as the frontend
  // runs on a different origin, which it does (:3000 vs :4001).
  publicBaseUrl: string;
  secret: string;
}

export function localMediaConfigFromEnv(secret: string): LocalMediaConfig | null {
  // Explicit opt-out for a production deploy that has no R2 yet: better a
  // clearly unavailable feature than one silently writing user video to a
  // disk that vanishes on the next deploy.
  if (process.env.NODE_ENV === 'production' && process.env.LOCAL_MEDIA_ALLOW_PRODUCTION !== 'true') return null;

  const port = process.env.PORT ?? '4001';
  return {
    root: path.resolve(process.env.LOCAL_MEDIA_DIR ?? DEFAULT_DIR),
    publicBaseUrl: (process.env.LOCAL_MEDIA_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    secret,
  };
}

// ---- Keys ----------------------------------------------------------------

// An object key is attacker-influenced (it arrives in a URL), and it is about
// to be joined onto a filesystem path. '../' is the obvious hazard; absolute
// paths, backslashes on a Windows host, and NUL bytes are the rest of it.
// Rejecting rather than sanitising, because a key that needs sanitising is not
// one this service issued.
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function resolveKeyPath(config: LocalMediaConfig, key: string): string {
  if (!isSafeKey(key)) throw new Error('unsafe_object_key');
  const resolved = path.resolve(config.root, key);
  // Belt and braces: even with the check above, the only thing that actually
  // proves containment is comparing the resolved path against the root.
  if (resolved !== config.root && !resolved.startsWith(config.root + path.sep)) throw new Error('unsafe_object_key');
  return resolved;
}

// ---- Signed URLs ---------------------------------------------------------

function signature(config: LocalMediaConfig, method: 'GET' | 'PUT', key: string, expiresAt: number): string {
  // The method is part of the signed string, so a link handed out to let a
  // browser PLAY a render cannot be replayed to OVERWRITE it.
  return createHmac('sha256', config.secret).update(`${method}|${key}|${expiresAt}`).digest('hex');
}

export function signLocalUrl(
  config: LocalMediaConfig,
  method: 'GET' | 'PUT',
  key: string,
  expiresInSec: number,
  now: Date = new Date()
): string {
  if (!isSafeKey(key)) throw new Error('unsafe_object_key');
  const expiresAt = Math.floor(now.getTime() / 1000) + expiresInSec;
  const token = signature(config, method, key, expiresAt);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${config.publicBaseUrl}/api/media/${encoded}?exp=${expiresAt}&token=${token}`;
}

export function verifyLocalUrl(
  config: LocalMediaConfig,
  method: 'GET' | 'PUT',
  key: string,
  expiresAt: unknown,
  token: unknown,
  now: Date = new Date()
): boolean {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  const exp = Number(expiresAt);
  if (!Number.isFinite(exp) || exp * 1000 < now.getTime()) return false;
  if (!isSafeKey(key)) return false;

  const expected = signature(config, method, key, exp);
  // Constant-time compare — a byte-by-byte early exit leaks how much of a
  // forged token was correct, which is enough to construct one.
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
}

// ---- StorageIo ------------------------------------------------------------

export function localStorageIo(config: LocalMediaConfig): StorageIo {
  return {
    async download(key, destPath) {
      await fs.copyFile(resolveKeyPath(config, key), destPath);
    },
    async upload(key, sourcePath) {
      const target = resolveKeyPath(config, key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(sourcePath, target);
    },
    publicUrl(key) {
      // A week, matching storage.ts's presigned fallback.
      return signLocalUrl(config, 'GET', key, 7 * 24 * 3600);
    },
  };
}
