'use client';

import { useCallback, useRef, useState, type SetStateAction } from 'react';

const STORAGE_KEY = 'sonar-session';

export interface Session {
  // NOT the session token. The token is an httpOnly cookie the browser holds
  // and this code cannot read — which is the whole point. What stays here is
  // only what the UI needs to render: who is signed in, and to which
  // workspace. None of it grants access to anything on its own.
  userId: string;
  userEmail: string;
  tenantId: string;
  tenantName: string;
}

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A blocked/full storage area must not make login unusable for the
    // current tab. The in-memory session still updates below.
  }
}

// Separate storage key and hook from useDevConfig on purpose — this is
// Логика Б (real self-serve signup/login), not the staff-assisted dev
// panel; the two must not read or clobber each other's state.
export function useSession() {
  const [session, setSessionState] = useState<Session | null>(readStoredSession);
  const sessionRef = useRef(session);

  // Persist before React schedules the render. Auth views redirect
  // immediately after calling this setter; an effect-based write races the
  // next client-only route reading localStorage during its first render.
  const setSession = useCallback((action: SetStateAction<Session | null>) => {
    const next = typeof action === 'function' ? action(sessionRef.current) : action;
    sessionRef.current = next;
    writeStoredSession(next);
    setSessionState(next);
  }, []);

  return [session, setSession] as const;
}
