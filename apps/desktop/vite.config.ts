// Vite config for the desktop shell. The UI is the playground's own source,
// aliased in (decision 9 in the task file) — the desktop entry swaps the router
// (HashRouter: tauri:// has no SPA fallback) and installs the platform before
// React boots. No dev proxy: the shell is BYOK/local only (ADR-0021 §7); the
// hub-server routes have no meaning against the tauri:// origin.

import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const playgroundSrc = fileURLToPath(new URL('../playground/src', import.meta.url));

/**
 * The shell is Snug's own binary, so it knows the ONE hosted share relay (ADR-0064) by
 * default — `tauri dev` and `tauri build` both bake it in without an env file (there is
 * no `apps/desktop/.env*`, by the same posture rule deploy-web enforces, and
 * release-desktop.mjs refuses one). Vite folds VITE_*-prefixed `process.env` entries
 * into `import.meta.env` when it loads env after this file, so defaulting here is the
 * mechanism — an explicit value in the environment still wins (a developer pointing at
 * a dev relay); a release refuses a value that differs from this one
 * (`desktopBuildEnv`). TASK-20260905-desktop-share-relay-default; pinned by
 * `shareRelayDefault.test.ts` against release-desktop.mjs's constant.
 */
export const DESKTOP_SHARE_RELAY_DEFAULT = 'https://share.snugprotocol.org';
process.env.VITE_SNUG_SHARE_RELAY ??= DESKTOP_SHARE_RELAY_DEFAULT;

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
