// The TEST build (D-B11). Same bundler, different entry: `main.test-hooks.ts` carries the
// DNS resolver, the holder override and the pins the suites need, and the RELEASE bundle
// carries none of them — which `check-host-mcp` proves by sweeping it for the prefix every
// hook's name shares. Both entries call the same `startProcess` (K5).
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
