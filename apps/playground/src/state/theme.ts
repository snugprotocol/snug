// theme.ts — the theme store: persisted (localStorage), defaults DARK (design brief:
// dark-first), and mirrored onto <html data-theme> so tokens.css flips. The Run view
// additionally forwards the value into the runner host (snug:host-event theme-change).

import type { ThemeName } from '@snugprotocol/runner';

import { createStore, useStore } from './store.js';

const THEME_KEY = 'snug:theme';

function readInitialTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return 'dark';
}

export const themeStore = createStore<ThemeName>(readInitialTheme());

export function applyThemeToDocument(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: ThemeName): void {
  themeStore.set(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode etc. — theme still applies for this session */
  }
  applyThemeToDocument(theme);
}

export function toggleTheme(): void {
  setTheme(themeStore.get() === 'dark' ? 'light' : 'dark');
}

export function useTheme(): ThemeName {
  return useStore(themeStore);
}

// Keep the document attribute honest on module load (index.html set it pre-paint).
applyThemeToDocument(themeStore.get());
