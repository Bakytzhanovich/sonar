'use client';

import { useCallback, useRef, useState, type SetStateAction } from 'react';

const STORAGE_KEY = 'sonar-dev-config';

export interface DevConfig {
  baseUrl: string;
  apiKey: string;
  botId: string;
  externalAccountId: string;
  devMode: boolean;
}

const DEFAULT_CONFIG: DevConfig = { baseUrl: 'http://localhost:4001', apiKey: '', botId: '', externalAccountId: '', devMode: false };

function readStoredConfig(): DevConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
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
