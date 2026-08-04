// Vite config for the playground SPA. The dev proxy makes /invoke + /artifacts
// same-origin against the local reference server, so server mode needs no CORS story.
// The Run view (sql.js + runner + db) is code-split behind React.lazy — see AC-9.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = 'http://127.0.0.1:8787';

/**
 * Dev proxy options.
 *
 * `changeOrigin: false` keeps the BROWSER's Host header (`localhost:5173`) on the way
 * through. That matters for the OAuth flow: the server builds its `redirect_uri` from
 * `request.host` (apps/server/src/routes/auth.ts), so with the Host rewritten to
 * `127.0.0.1:8787` the login leg set the `snug_oidc` cookie under `localhost` while
 * Google then redirected the browser to `127.0.0.1` — a different cookie domain, so the
 * cookie was never sent back and the callback failed with LOGIN_STATE_MISSING.
 * Preserving the Host keeps both legs on one origin.
 *
 * The timeouts admit a >=30-minute streaming build: without them a long `/invoke`
 * response dies in the proxy rather than at either end (TASK-20260803-hub-ops AC5).
 */
const proxyOptions = {
  target: SERVER,
  changeOrigin: false,
  timeout: 0,
  proxyTimeout: 0,
} as const;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/invoke': proxyOptions,
      '/artifacts': proxyOptions,
      '/auth': proxyOptions,
      '/userdb': proxyOptions,
    },
  },
  build: {
    // sql.js's wasm asset must ship as a file, never inlined as base64 into the bundle.
    assetsInlineLimit: (filePath, content) =>
      filePath.endsWith('.wasm') ? false : content.length < 4096,
  },
});
