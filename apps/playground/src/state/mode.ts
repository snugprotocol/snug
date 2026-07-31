// mode.ts — playground mode (server | byok) and the BYOK credential rules.
//
// SECURITY (task AC-5): the BYOK API key lives in sessionStorage ONLY — never
// localStorage, never a cookie, never any request to the reference server. It dies
// with the tab. A unit test asserts the localStorage half of this contract.

import { createStore, useStore } from './store.js';

export type PlaygroundMode = 'server' | 'byok';
export type ByokProvider = 'mock' | 'anthropic' | 'openai';

const MODE_KEY = 'snug:mode';
const PROVIDER_KEY = 'snug:byok-provider';
/** sessionStorage key for the BYOK API key — the ONLY place the key is ever stored. */
export const BYOK_KEY_STORAGE_KEY = 'snug:byok-key';

function readMode(): PlaygroundMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'byok' ? 'byok' : 'server';
  } catch {
    return 'server';
  }
}

function readProvider(): ByokProvider {
  try {
    const stored = localStorage.getItem(PROVIDER_KEY);
    if (stored === 'anthropic' || stored === 'openai' || stored === 'mock') return stored;
  } catch {
    /* fall through */
  }
  return 'mock';
}

export const modeStore = createStore<PlaygroundMode>(readMode());
export const providerStore = createStore<ByokProvider>(readProvider());

export function setMode(mode: PlaygroundMode): void {
  modeStore.set(mode);
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* non-persistent is fine */
  }
}

export function setProvider(provider: ByokProvider): void {
  providerStore.set(provider);
  try {
    localStorage.setItem(PROVIDER_KEY, provider);
  } catch {
    /* non-persistent is fine */
  }
}

/** Store the BYOK key for this tab only. Empty/whitespace clears it. */
export function setByokKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed === '') {
    sessionStorage.removeItem(BYOK_KEY_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(BYOK_KEY_STORAGE_KEY, trimmed);
}

export function getByokKey(): string | undefined {
  const stored = sessionStorage.getItem(BYOK_KEY_STORAGE_KEY);
  return stored === null || stored === '' ? undefined : stored;
}

export function useMode(): PlaygroundMode {
  return useStore(modeStore);
}

export function useProvider(): ByokProvider {
  return useStore(providerStore);
}
