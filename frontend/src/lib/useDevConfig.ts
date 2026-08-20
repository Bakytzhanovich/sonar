'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sonar-dev-config';

export interface DevConfig {
  baseUrl: string;
  apiKey: string;
  botId: string;
  externalAccountId: string;
}

const DEFAULT_CONFIG: DevConfig = { baseUrl: 'http://localhost:4001', apiKey: '', botId: '', externalAccountId: '' };

function readStoredConfig(): DevConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
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
  const [config, setConfig] = useState<DevConfig>(readStoredConfig);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  return [config, setConfig] as const;
}
