// One file out (D-B2). Vite in SSR/library mode is the repo's one bundling tool; every
// other Node package here is `tsc` to a multi-file dist, so this is a new pattern chosen
// deliberately: the plugin ships a single `snug-mcp.mjs` that a host spawns by path, and a
// dist directory of loose modules would be a distribution surface with no upside.
//
// `ssr.noExternal: true` inlines the workspace packages. The guards are DEEP-imported by
// their consumers (see fetch-proxy.ts) so the auth barrel — which reaches @snugprotocol/db
// and drags in sql.js and the provider registry — never enters the graph.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false, // a marketplace plugin should be readable by whoever reviews it
    rollupOptions: { output: { entryFileNames: 'snug-mcp.mjs', format: 'esm', inlineDynamicImports: true } },
  },
  ssr: { noExternal: true, target: 'node' },
});
