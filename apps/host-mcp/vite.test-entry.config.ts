// The TEST build (D-B11). Same bundler, different entry: `main.test-hooks.ts` carries the
// DNS resolver and holder override the e2e needs, and the RELEASE bundle carries neither —
// which `check-host-mcp` proves by sweeping it for these names.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/main.test-hooks.ts',
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: false, // the release bundle is already here
    minify: false,
    rollupOptions: { output: { entryFileNames: 'snug-mcp.test.mjs', format: 'esm', inlineDynamicImports: true } },
  },
  ssr: { noExternal: true, target: 'node' },
});
