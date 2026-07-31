// Vite config for the playground SPA. The dev proxy makes /invoke + /artifacts
// same-origin against the local reference server, so server mode needs no CORS story.
// The Run view (sql.js + runner + db) is code-split behind React.lazy — see AC-9.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/invoke': SERVER,
      '/artifacts': SERVER,
    },
  },
  build: {
    // sql.js's wasm asset must ship as a file, never inlined as base64 into the bundle.
    assetsInlineLimit: (filePath, content) =>
      filePath.endsWith('.wasm') ? false : content.length < 4096,
  },
});
