'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useDevConfig } from './useDevConfig';
import { useSession } from './useSession';

// Onboarding writes this alongside the session; signing out has to clear it
// too, or the next person to sign in on this browser inherits a stranger's
// "you already ran the demo" state.
export const ONBOARDING_PROGRESS_KEY = 'sonar-onboarding-progress';

// Signing out lives here rather than in a component because it has to clear
// THREE separate stores that were written by different screens — the session,
// the dev config, and the onboarding progress. Leaving any one behind means
// the next sign-in starts with someone else's leftovers: most seriously the
// apiKey, which would let the next user act as the previous tenant.
export function useLogout() {
  const router = useRouter();
  const [session, setSession] = useSession();
  const [, setDevConfig] = useDevConfig();

  return useCallback(() => {
    const token = session?.sessionToken;
    setSession(null);

    setDevConfig((current) =>
      // Only clear the key if it IS this session's token. The dev panel's
      // "Быстрый старт" writes a real tenant apiKey here that has nothing to
      // do with the login; wiping that on logout would silently break a
      // staff-assisted demo set up minutes earlier.
      token && current.apiKey === token
        ? { ...current, apiKey: '', botId: '', externalAccountId: '' }
        : current
    );

    try {
      localStorage.removeItem(ONBOARDING_PROGRESS_KEY);
    } catch {
      // Storage unavailable (private window, blocked site data) — the
      // session is already gone, which is what actually signs the user out.
    }

    router.replace('/login');
  }, [router, session, setDevConfig, setSession]);
}
