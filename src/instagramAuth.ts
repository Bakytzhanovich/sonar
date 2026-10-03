import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Connecting an Instagram account — "Instagram API with Instagram Login".
//
// Chosen over Facebook Login for Business because that one only works for an
// Instagram account linked to a Facebook Page, and many of the bloggers this
// is for have no Page. This one takes any professional (business or creator)
// account directly.
//
// The flow, in four requests:
//   1. the browser goes to instagram.com with our app id and a signed `state`;
//   2. Instagram sends it back to us with a one-time `code`;
//   3. the code becomes a short-lived token (an hour);
//   4. that becomes a long-lived one (60 days), which is what we keep, and
//      which refreshTokenIfDue renews before it runs out.
//
// Nothing here logs a token or a URL that carries one: those URLs put the
// token in the query string, and a logged URL is a leaked token.
//
// All network calls take `fetchImpl` so the tests never reach Meta.

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';
// The profile read is versioned; the token endpoints above are not.
const GRAPH_VERSION = 'v22.0';
const TIMEOUT_MS = 15_000;

/** What the app may do: read the profile, and publish. Nothing about DMs or
 *  comments — asking for more than is used is what fails App Review. */
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];

export interface InstagramAppConfig {
  appId: string;
  appSecret: string;
  /** Must match, character for character, one registered in the Meta app. */
  redirectUri: string;
}

export class InstagramAuthError extends Error {
  constructor(
    readonly reason: 'exchange_failed' | 'long_lived_failed' | 'profile_failed' | 'refresh_failed' | 'network',
    detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'InstagramAuthError';
  }
}

export function instagramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InstagramAppConfig | null {
  const appId = env.INSTAGRAM_APP_ID?.trim();
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim();
  const redirectUri = env.INSTAGRAM_REDIRECT_URI?.trim();
  return appId && appSecret && redirectUri ? { appId, appSecret, redirectUri } : null;
}

// ---- state ------------------------------------------------------------------
//
// `state` carries which workspace started the connection, signed so it cannot
// be forged, and short-lived so an old one cannot be replayed. That is what
// stops someone from walking a victim through a link that connects the
// attacker's Instagram to the victim's workspace: a state naming the victim's
// workspace can only be minted by the victim's own session.

const STATE_TTL_MS = 10 * 60 * 1000;

export function signState(secret: string, tenantId: string, now: Date = new Date()): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, e: now.getTime() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** The tenant the state was minted for, or null when forged, garbled or old. */
export function verifyState(secret: string, state: unknown, now: Date = new Date()): string | null {
  if (typeof state !== 'string') return null;
  const [payload, mac] = state.split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { t?: unknown; e?: unknown };
    if (typeof body.t !== 'string' || typeof body.e !== 'number' || body.e < now.getTime()) return null;
    return body.t;
  } catch {
    return null;
  }
}

// ---- the requests -------------------------------------------------------------

export function authorizeUrl(config: InstagramAppConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: INSTAGRAM_SCOPES.join(','),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Instagram user ids are larger than a JavaScript number holds exactly
 * (17841400000000000 and up), and JSON.parse rounds them silently — the
 * account would be saved under an id that is not its own. Read off the raw
 * text before parsing instead.
 */
export function readUserId(raw: string): string | null {
  return raw.match(/"user_id"\s*:\s*"?(\d+)"?/)?.[1] ?? raw.match(/"id"\s*:\s*"?(\d+)"?/)?.[1] ?? null;
}

async function call(
  fetchImpl: typeof fetch,
  reason: InstagramAuthError['reason'],
  url: string,
  init?: RequestInit
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // The error's own text, never the URL, which may carry a token.
    throw new InstagramAuthError('network', err instanceof Error ? err.name : 'fetch failed');
  }
  const text = await res.text();
  if (!res.ok) throw new InstagramAuthError(reason, `${res.status} ${text.slice(0, 300)}`);
  return text;
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: Date;
}

export interface ConnectedProfile extends LongLivedToken {
  userId: string;
  username: string | null;
}

/** Steps 3 and 4 plus a profile read: a code in, an account to save out. */
export async function connectWithCode(
  config: InstagramAppConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<ConnectedProfile> {
  // Instagram appends "#_" to the code in the redirect; it is not part of it.
  const cleanCode = code.replace(/#_$/, '');
  const shortRaw = await call(fetchImpl, 'exchange_failed', TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.appId,
      client_secret: config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code: cleanCode,
    }),
  });
  // Documented both flat and wrapped in `data: [...]`; accept either.
  const shortBody = JSON.parse(shortRaw) as { access_token?: string; data?: Array<{ access_token?: string }> };
  const shortToken = shortBody.access_token ?? shortBody.data?.[0]?.access_token;
  if (!shortToken) throw new InstagramAuthError('exchange_failed', 'no access_token');

  const long = await exchangeForLongLived(config, shortToken, fetchImpl, now);

  const profileRaw = await call(
    fetchImpl,
    'profile_failed',
    `${GRAPH}/${GRAPH_VERSION}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: long.accessToken })}`
  );
  const userId = readUserId(profileRaw) ?? readUserId(shortRaw);
  if (!userId) throw new InstagramAuthError('profile_failed', 'no user id');
  const username = (JSON.parse(profileRaw) as { username?: unknown }).username;
  return { ...long, userId, username: typeof username === 'string' ? username : null };
}

function readLongLived(raw: string, reason: InstagramAuthError['reason'], now: Date): LongLivedToken {
  const body = JSON.parse(raw) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new InstagramAuthError(reason, 'no token in answer');
  }
  return { accessToken: body.access_token, expiresAt: new Date(now.getTime() + body.expires_in * 1000) };
}

export async function exchangeForLongLived(
  config: InstagramAppConfig,
  shortToken: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<LongLivedToken> {
  const raw = await call(
    fetchImpl,
    'long_lived_failed',
    `${GRAPH}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: config.appSecret, access_token: shortToken })}`
  );
  return readLongLived(raw, 'long_lived_failed', now);
}

/** A long-lived token renewed for another 60 days. Instagram allows it once
 *  the token is a day old and until it expires — not after. */
export async function refreshLongLived(token: string, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<LongLivedToken> {
  const raw = await call(
    fetchImpl,
    'refresh_failed',
    `${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`
  );
  return readLongLived(raw, 'refresh_failed', now);
}
