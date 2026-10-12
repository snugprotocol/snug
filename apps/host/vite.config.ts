// Vite config for the host kit (TASK-20260905-host-kit P1/P4/P5). The UI is the playground's
// own source aliased in, as the desktop does (ADR-0021 D9); what differs is the OUTPUT: one
// self-contained page. Every chunk is inlined (`inlineDynamicImports`), every asset becomes
// a data URL, the entry script and the stylesheet are folded into the html by
// `inlineSingleFile`, and eight modules are swapped by resolved path (`swapResolved`, whose
// dead-swap guard fails the build if a swap stops being hit): the starter source (the ≈ 1 MB
// of starter bytes load on click — AC14), the sql.js locator (the engine rides as bytes — P4),
// and the chat's data lane — `agent/chatRouter`, `agent/laneTools`, `agent/accessProposeTool`,
// `agent/accessCard` and `access/AccessCard` (TASK-20261010-host-broker PR-2, the owner's
// kit-ceiling cut of 2026-10-11) — and the scheduled agent, `schedule/appAgent` (PR-4). The
// invariant that cut stands on: every kit binding pins the HOST brain, composed `tools: false`, or
// the DEMO brain, so no kit turn is ever routed to a lane, the data lane — PR-2's chat door and
// the brain's ask on it included — never runs here, and the scheduler's brain gates refuse or
// degrade every *ask* step before the agent is reached; the stubs under `src/stubs/` keep the
// names and fail loudly, and `src/__tests__/kitDeadLanes.test.ts` pins the swaps, the invariant
// and the stubs' surface.
// The knowledge package's content module is rewritten without the prompt files nothing
// shipped reads — everything under `skills/` and the store's `README.md` (`dropPromptFiles`,
// whose dead-rule guard fails the build the same way; TASK-20261010-host-broker PR-3,
// `kitDeadPrompts.test.ts`).
// The playground and the desktop keep the real modules and the whole prompt store — they are
// not built from this config.
// WebLLM is aliased to a stub so the lazily imported 6 MB engine never enters the bundle.
//
// THE ONLY CONFIG, THE ONLY ENTRY, THE ONLY OUTPUT (TASK-20261003 K1, ADR-0072 §1). This
// page is the artifact page, the chat page, the plain file AND the page the local host
// process serves; which of those it is, it finds out at runtime (`src/boot.tsx`). A second
// config used to build the same sources into a second page for the runner — a restatement
// of this file that differed in three lines, the same size, shipped beside it in the plugin.
// A structural test (`src/__tests__/oneKit.test.ts`) fails on a second config or html entry
// here; a second input is refused by `inlineDynamicImports` as well.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { buildStamp } from './src/plugins/build-stamp.js';
import { dropPromptFiles } from './src/plugins/drop-prompt-files.js';
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
      // The chat's data lane and the brain's ask on it → stubs that name the fact (the header;
      // TASK-20261010-host-broker PR-2, `kitDeadLanes.test.ts`).
      [`${playgroundSrc}/agent/chatRouter.ts`]: here('./src/stubs/chatRouter.ts'),
      [`${playgroundSrc}/agent/laneTools.ts`]: here('./src/stubs/laneTools.ts'),
      [`${playgroundSrc}/agent/accessProposeTool.ts`]: here('./src/stubs/accessProposeTool.ts'),
      [`${playgroundSrc}/agent/accessCard.ts`]: here('./src/stubs/accessCard.ts'),
      [`${playgroundSrc}/access/AccessCard.tsx`]: here('./src/stubs/AccessCard.tsx'),
      // The scheduled agent → a stub that names the fact: every kit brain is refused or degraded
      // before the executors' lazy import reaches it (TASK-20261010-host-broker PR-4, D-PR4-15).
      [`${playgroundSrc}/schedule/appAgent.ts`]: here('./src/stubs/appAgent.ts'),
    }),
    // The prompt files nothing shipped reads (everything under `skills/`, the store's README)
    // → out of the page (the header; TASK-20261010-host-broker PR-3, `kitDeadPrompts.test.ts`).
    dropPromptFiles({ contentModule: here('../../packages/knowledge/dist/generated/content.js') }),
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
