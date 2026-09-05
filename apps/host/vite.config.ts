// Vite config for the host kit (TASK-20260905-host-kit P1/P4/P5). The UI is the playground's
// own source aliased in, as the desktop does (ADR-0021 D9); what differs is the OUTPUT: one
// self-contained page. Every chunk is inlined (`inlineDynamicImports`), every asset becomes
// a data URL, the entry script and the stylesheet are folded into the html by
// `inlineSingleFile`, and two modules are swapped by resolved path: the starter source (the
// ≈ 1 MB of starter bytes load on click — AC14) and the sql.js locator (the engine rides as
// bytes — P4). WebLLM is aliased to a stub so the lazily imported 6 MB engine never enters
// the bundle. A second input is refused by `inlineDynamicImports`; the micro kit (T5) gets
// its own config.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { buildStamp } from './src/plugins/build-stamp.js';
import { inlineSingleFile } from './src/plugins/inline-single-file.js';
import { startersIndexPlugin } from './src/plugins/starters-index.js';
import { swapResolved } from './src/plugins/swap-resolved.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const playgroundSrc = here('../playground/src');

const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8')) as { version: string };
const git = (args: string): string => execSync(`git ${args}`, { cwd: here('.'), encoding: 'utf8' }).trim();
const stamp = buildStamp({
  version: pkg.version,
  sha: process.env.SNUG_HOST_BUILD_SHA ?? git('rev-parse --short=7 HEAD'),
  dirty: process.env.SNUG_HOST_BUILD_SHA === undefined && git('status --porcelain') !== '',
});

export default defineConfig({
  plugins: [
    swapResolved({
      // The ONE owner of the examples globs → the on-demand loader (AC14, A3).
      [`${playgroundSrc}/starter/starterSource.ts`]: here('./src/starterSource.ts'),
      // The ?url engine asset → a locator that must never run (P4/AC8).
      [`${playgroundSrc}/run/wasm.ts`]: here('./src/stubs/wasm-locator.ts'),
    }),
    startersIndexPlugin(here('./starters-pkg/index.json')),
    react(),
    inlineSingleFile({ stamp, fileName: 'snug-host.html' }),
  ],
  resolve: {
    alias: {
      '@playground': playgroundSrc,
      '@mlc-ai/web-llm': here('./src/stubs/webllm.ts'),
    },
  },
  base: './',
  clearScreen: false,
  // No `esbuild.supported['inline-script']` override: by DEFAULT esbuild escapes `</script`
  // inside string literals (`<\/script`) because the output may be inlined — setting the
  // feature to `false` switches that protection OFF (measured 2026-09-05). The inliner
  // refuses any `</script` that survives, so the default is load-bearing and pinned there.
  // Vite 6 does not count `.wasm` as an asset type (it reserves `?init`/`?url` for it), so
  // the `?inline` import in wasmBytes.ts needs the engine admitted as an asset explicitly.
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'es2022',
    // Every asset inline — the opposite of the playground's `.wasm`-never-inlined rule,
    // here and only here (the engine itself comes through `?inline` in wasmBytes.ts).
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    // One chunk, nothing to preload. (The lazy RunView import's `__VITE_PRELOAD__` marker
    // is resolved by Vite's own generateBundle — the inliner must run AFTER it, see its
    // `order: 'post'`; the inliner refuses a surviving marker.)
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
