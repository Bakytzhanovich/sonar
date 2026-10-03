// Publishing a reel through the Instagram API with Instagram Login.
//
// Meta's flow is three calls with a wait in the middle:
//   1. create a media container from a public video URL — Instagram fetches
//      the file itself;
//   2. poll the container until Instagram has transcoded it (seconds to
//      minutes);
//   3. publish the container — the one call that puts something on the
//      person's profile, and so the one that must never happen twice.
//
// The token travels in the Authorization header, never in a URL, so no log
// line or proxy record of a request URL can carry it.
//
// Every call takes `fetchImpl`: the tests never reach Meta.

const GRAPH = 'https://graph.instagram.com/v22.0';
const TIMEOUT_MS = 30_000;

export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

/** Why a call failed, sorted by what to do about it. */
export type InstagramFailure =
  /** The token is dead: only the person reconnecting can fix it. */
  | 'token_invalid'
  /** Too many calls or posts: wait, then try again. */
  | 'rate_limited'
  /** Instagram refused this post (format, length, policy): retrying will not help. */
  | 'rejected'
  /** Network, timeout, Meta's own 5xx: try again shortly. */
  | 'transient';

export class InstagramPublishError extends Error {
  constructor(readonly kind: InstagramFailure, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = 'InstagramPublishError';
  }
}

/**
 * Meta's error codes, by what they mean for us. 190 is an expired or revoked
 * token; 4, 17, 32 and 613 are the rate limits; 9 with subcode 2207042 is
 * the daily publishing limit. Everything else from a 4xx is a refusal of the
 * post itself, and a 5xx is Meta having a bad minute.
 */
export function classifyGraphError(status: number, body: string): InstagramPublishError {
  let code: number | undefined;
  let subcode: number | undefined;
  let message = body.slice(0, 300);
  try {
    const err = (JSON.parse(body) as { error?: { code?: number; error_subcode?: number; message?: string; error_user_msg?: string } }).error;
    code = err?.code;
    subcode = err?.error_subcode;
    message = (err?.error_user_msg || err?.message || message).slice(0, 300);
  } catch {
    // Not JSON: the status decides.
  }
  if (code === 190 || status === 401) return new InstagramPublishError('token_invalid', message);
  if (code === 4 || code === 17 || code === 32 || code === 613 || subcode === 2207042 || status === 429) {
    return new InstagramPublishError('rate_limited', message);
  }
  if (status >= 500) return new InstagramPublishError('transient', message);
  return new InstagramPublishError('rejected', message);
}

async function graph<T>(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST'; form?: Record<string, string> } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH}${path}`, {
      method: init.method ?? 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.form ? new URLSearchParams(init.form) : undefined,
    });
  } catch (err) {
    throw new InstagramPublishError('transient', err instanceof Error ? err.name : 'fetch failed');
  }
  const text = await res.text();
  if (!res.ok) throw classifyGraphError(res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InstagramPublishError('transient', 'answer is not JSON');
  }
}

/** How many API posts the account has left in Instagram's rolling 24 hours. */
export async function publishingQuotaLeft(fetchImpl: typeof fetch, token: string, igUserId: string): Promise<number> {
  const body = await graph<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    fetchImpl,
    token,
    `/${igUserId}/content_publishing_limit?fields=quota_usage,config`
  );
  const row = body.data?.[0];
  const total = row?.config?.quota_total;
  // Unknown is not zero: an answer without the numbers does not block a
  // post, Instagram will still refuse one over the limit with a clear error.
  if (typeof total !== 'number' || typeof row?.quota_usage !== 'number') return Number.POSITIVE_INFINITY;
  return total - row.quota_usage;
}

export async function createReelContainer(
  fetchImpl: typeof fetch,
  token: string,
  igUserId: string,
  videoUrl: string,
  caption: string
): Promise<string> {
  const body = await graph<{ id?: string }>(fetchImpl, token, `/${igUserId}/media`, {
    method: 'POST',
    form: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' },
  });
  if (!body.id) throw new InstagramPublishError('transient', 'no container id');
  return String(body.id);
}

export async function containerStatus(
  fetchImpl: typeof fetch,
  token: string,
  containerId: string
): Promise<{ status: ContainerStatus; detail: string }> {
  const body = await graph<{ status_code?: string; status?: string }>(fetchImpl, token, `/${containerId}?fields=status_code,status`);
  const status = (body.status_code ?? 'IN_PROGRESS') as ContainerStatus;
  return { status, detail: body.status ?? '' };
}

/** The irreversible step. Returns the new media id. */
export async function publishContainer(fetchImpl: typeof fetch, token: string, igUserId: string, containerId: string): Promise<string> {
  const body = await graph<{ id?: string }>(fetchImpl, token, `/${igUserId}/media_publish`, {
    method: 'POST',
    form: { creation_id: containerId },
  });
  if (!body.id) throw new InstagramPublishError('transient', 'no media id');
  return String(body.id);
}

/** The post's public link. Best effort: a published reel without its link
 *  is still published. */
export async function mediaPermalink(fetchImpl: typeof fetch, token: string, mediaId: string): Promise<string | null> {
  try {
    const body = await graph<{ permalink?: string }>(fetchImpl, token, `/${mediaId}?fields=permalink`);
    return body.permalink ?? null;
  } catch {
    return null;
  }
}
