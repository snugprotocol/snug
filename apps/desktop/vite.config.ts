// Vite config for the desktop shell. The UI is the playground's own source,
// aliased in (decision 9 in the task file) — the desktop entry swaps the router
// (HashRouter: tauri:// has no SPA fallback) and installs the platform before
// React boots. No dev proxy: the shell is BYOK/local only (ADR-0021 §7); the
// hub-server routes have no meaning against the tauri:// origin.

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const playgroundSrc = fileURLToPath(new URL('../playground/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@playground': playgroundSrc,
    },
  },
  // Tauri serves relative to the app root; keep asset URLs relative.
  base: './',
  clearScreen: false,
  build: {
    // Same rule as the playground: sql.js's wasm ships as a file, never inlined.
    assetsInlineLimit: (filePath, content) =>
      filePath.endsWith('.wasm') ? false : content.length < 4096,
  },
});
