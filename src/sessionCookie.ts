import type { Request, Response } from 'express';

// The session token lives in an httpOnly cookie rather than in localStorage,
// so page JavaScript cannot read it. That matters more than it sounds: any
// dependency the frontend pulls in runs with full access to localStorage, and
// a single compromised package (or one XSS hole) hands over a token that is
// valid for a week. A cookie the browser will not expose to script removes
// that whole class of theft.
//
// The trade CSRF-for-XSS that this normally implies does NOT apply here,
// because the frontend proxies /api/* to this server: the cookie is
// same-site, so SameSite=Lax alone stops a third-party page from sending it.
// The Origin check below is the second line for exactly the requests that
// would matter if that ever stopped being true.

export const SESSION_COOKIE = 'sonar_session';

// Matches the JWT's own lifetime — a cookie outliving the token would leave
// the user "logged in" right up until the first request fails.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function isSecureDeployment(): boolean {
  // Secure cookies are dropped silently over plain http, which would break
  // local development in a way that looks like a login bug.
  return process.env.NODE_ENV === 'production';
}

export function buildSessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: Strict would omit the cookie when the user arrives by
    // following a link from outside (an email, a chat message), landing them
    // on a logged-out page for no security gain that Lax does not give.
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (isSecureDeployment()) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedSessionCookie(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureDeployment()) parts.push('Secure');
  return parts.join('; ');
}

// Minimal parser instead of a dependency: one cookie is read, by exact name,
// and anything unparseable is simply absent.
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const piece of header.split(';')) {
    const index = piece.indexOf('=');
    if (index === -1) continue;
    if (piece.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = piece.slice(index + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects a state-changing request whose Origin is not one we serve.
 *
 * Defence in depth behind SameSite=Lax. Lax already withholds the cookie from
 * cross-site POSTs, but it is a browser-side guarantee: it does nothing for an
 * older browser, and it silently weakens if the cookie ever has to become
 * SameSite=None (a second frontend on another domain, say). This check is
 * server-side and does not care.
 *
 * Requests carrying no Origin at all are allowed: that is a server-to-server
 * API client, which authenticates with an API key rather than this cookie.
 */
export function isAllowedOrigin(req: Request, allowedOrigin: string): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  // Only cookie-authenticated requests are at risk — a Bearer header is never
  // attached by the browser on its own.
  if (req.header('authorization')) return true;

  const origin = req.header('origin');
  if (!origin) return true;
  if (allowedOrigin === '*') return true;

  return origin === allowedOrigin;
}

export function setSessionCookie(res: Response, token: string): void {
  res.setHeader('Set-Cookie', buildSessionCookie(token));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', buildClearedSessionCookie());
}

export function sessionTokenFromRequest(req: Request): string | null {
  const header = req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return readSessionCookie(req.header('cookie'));
}
