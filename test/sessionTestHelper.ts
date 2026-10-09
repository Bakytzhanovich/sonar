import { SESSION_COOKIE } from '../src/sessionCookie';

/**
 * The session token as the browser receives it: from the httpOnly cookie,
 * since the response body no longer carries it. Tests then present it as a
 * Bearer credential, which the API accepts in place of the cookie.
 */
export function sessionTokenFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const cookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error(`no ${SESSION_COOKIE} cookie in the response`);
  return decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1).split(';')[0]);
}
