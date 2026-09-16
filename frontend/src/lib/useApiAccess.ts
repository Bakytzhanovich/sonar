'use client';

import { useDevConfig } from './useDevConfig';
import { useSession } from './useSession';

/**
 * Whether this browser can call the API, and the config to call it with.
 *
 * Every module screen used to ask the same question as `if (!apiKey)`, which
 * stopped being the right question when the session moved into an httpOnly
 * cookie: the page cannot see that cookie, so a signed-in user has an empty
 * apiKey and their requests authenticate anyway. Screens gated on the key
 * alone showed "no access" while working perfectly underneath.
 *
 * Two credentials reach the API, and only one of them is visible here:
 *   - the session cookie, which the browser attaches by itself. Its presence
 *     is inferred from the stored session metadata (email, tenant), which is
 *     written and cleared alongside it.
 *   - the dev-panel apiKey from "Быстрый старт", which is a real tenant key
 *     and does travel in a header.
 */
export function useApiAccess() {
  const [devConfig] = useDevConfig();
  const [session] = useSession();

  const config = { baseUrl: devConfig.baseUrl, apiKey: devConfig.apiKey };

  return {
    config,
    apiKey: devConfig.apiKey,
    botId: devConfig.botId,
    hasAccess: Boolean(devConfig.apiKey) || session !== null,
  };
}
