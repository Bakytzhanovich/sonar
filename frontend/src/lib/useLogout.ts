'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';
import { API_BASE_URL } from './apiConfig';
import { useSession } from './useSession';

// Onboarding writes this alongside the session; signing out has to clear it
// too, or the next person to sign in on this browser inherits a stranger's
// "you already ran the demo" state.
export const ONBOARDING_PROGRESS_KEY = 'sonar-onboarding-progress';

// Signing out is a server round trip now, not a local delete: the session
// lives in an httpOnly cookie that page scripts cannot touch. What remains
// local is display state (who was signed in, onboarding progress), and it is
// cleared here so the next person on this browser does not inherit it.
export function useLogout() {
  const router = useRouter();
  const [, setSession] = useSession();

  return useCallback(async () => {
    // The session cookie is httpOnly, so only the server can remove it —
    // clearing local state alone would leave the browser still authenticated.
    // Failure is not fatal: the local state is cleared regardless, and the
    // cookie expires on its own.
    await api.logout({ baseUrl: API_BASE_URL }).catch(() => {});

    setSession(null);

    // devConfig.apiKey is no longer ever the session token — it only holds a
    // real tenant key from the dev panel's "Быстрый старт", which has nothing
    // to do with this login and would break a staff-assisted demo if wiped.
    try {
      localStorage.removeItem(ONBOARDING_PROGRESS_KEY);
    } catch {
      // Storage unavailable (private window, blocked site data) — the
      // session is already gone, which is what actually signs the user out.
    }

    router.replace('/login');
  }, [router, setSession]);
}
