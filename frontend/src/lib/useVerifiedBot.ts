'use client';

import { useEffect } from 'react';
import { api } from './api';
import { API_BASE_URL } from './apiConfig';

/**
 * Keeps the remembered bot one that belongs to whoever is signed in.
 *
 * The chosen bot lives in this browser's storage, not in the account. On a
 * shared computer — an agency, a family laptop — the next person to sign in
 * inherited the previous person's bot: the server rightly refused it (404),
 * and the CRM and the bot editor simply did not work. Checked against the
 * account's own bots on every visit, so it also heals when a session changed
 * without anyone pressing "Выйти" (an expired cookie, a new sign-in).
 */
export function useVerifiedBot(botId: string, setBotId: (id: string) => void): void {
  useEffect(() => {
    let cancelled = false;
    api
      .listBots({ baseUrl: API_BASE_URL })
      .then(({ bots }) => {
        if (cancelled) return;
        if (botId && bots.some((bot) => bot.id === botId)) return;
        const own = bots[0]?.id ?? '';
        if (own !== botId) setBotId(own);
      })
      // Signed out, or offline: nothing to verify against, and the screen
      // already says so in its own way.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);
}
