'use client';

import { useCallback, useRef, useState, type SetStateAction } from 'react';
import { API_BASE_URL } from './apiConfig';

const STORAGE_KEY = 'sonar-dev-config';

export interface DevConfig {
  baseUrl: string;
  apiKey: string;
  botId: string;
  externalAccountId: string;
  devMode: boolean;
}

// baseUrl is whatever API_BASE_URL resolves to — empty by default, meaning
// "this origin", because the frontend proxies /api/* to the backend. It is
// not a per-browser setting any more: addressing the API directly would make
// every request cross-origin, and a SameSite=Lax session cookie is not sent
// across origins.
const DEFAULT_CONFIG: DevConfig = { baseUrl: API_BASE_URL, apiKey: '', botId: '', externalAccountId: '', devMode: false };

function readStoredConfig(): DevConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    return {
      ...DEFAULT_CONFIG,
      ...JSON.parse(raw),
      // baseUrl is NOT restored from storage. It stopped being a per-browser
      // setting when the frontend started proxying /api/*: the browser must
      // address this origin so the session cookie is same-site. A value saved
      // before that change still pointed at the API's own host, which sent
      // every request cross-origin — the cookie was withheld and the whole
      // app 401'd for anyone who had used it before the switch.
      baseUrl: API_BASE_URL,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeStoredConfig(config: DevConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Keep the current tab usable if persistent storage is unavailable.
  }
}

// Shared across the flow editor and the CRM page so setting apiKey/botId
// once (e.g. via "Быстрый старт") carries over when navigating between
// them, instead of re-entering the same values on every route.
//
// Reading localStorage in the useState lazy initializer (not an effect)
// is safe here specifically because every caller of this hook is a
// client-only component (dynamic import with ssr:false) — there is no
// server-rendered pass for a client-only read to mismatch against.
export function useDevConfig() {
  const [config, setConfigState] = useState<DevConfig>(readStoredConfig);
  const configRef = useRef(config);

  // Onboarding stores the JWT-backed workspace and immediately navigates to
  // CRM. Write synchronously so that route cannot mount with stale bot/API
  // credentials while waiting for a useEffect.
  const setConfig = useCallback((action: SetStateAction<DevConfig>) => {
    const next = typeof action === 'function' ? action(configRef.current) : action;
    configRef.current = next;
    writeStoredConfig(next);
    setConfigState(next);
  }, []);

  return [config, setConfig] as const;
}
