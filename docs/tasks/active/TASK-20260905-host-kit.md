# TASK-20260905-host-kit: the host kit — `apps/host` builds `snug-host.html` and `snug-host-micro.html` (T2 of TASK-20260904-skill-only-snug)

- **Status**: planned — **awaiting plan approval (Gate 2)**; High tier, so the plan gets a fresh-context AI review before any code (its findings are folded below)
- **Owner**: Jeetu
- **Risk tier**: high — touches `packages/runner` (a host-ready capability option beside the CSP path), `packages/db` (the sql.js driver), and produces a page whose whole job is to embed the sandboxed runner inside foreign hosts (C2 adjacent)
- **Branch**: `feat/TASK-20260905-host-kit` (carries T1's done-move)
- **Packages touched**: `apps/host` (new), `apps/playground` (platform seam + capability gating), `packages/db` (`wasmBinary`), `packages/runner` (`streaming` override on host-ready), `packages/knowledge` (`HostPlatform` gains `'host'`), `scripts/` (`check-host-kit`), root `package.json`/`gate-local.mjs`, `docs/`
- **Spec impact**: none — `snug:host-ready`'s schema is untouched; the kit reports truth through the flags that exist (`streaming`, `db`, `auth`, `net`, `openUrl`). A `platform`/`binding` seat on host-ready is deliberately NOT added (apps degrade on the flags they already read; a seat would be a High spec change with no consumer).
- **Related**: parent [TASK-20260904-skill-only-snug](TASK-20260904-skill-only-snug.md) (D1, D2, D3, D4, D15, AC4, AC8); ADR-0065 (proposed); ADR-0021 (the desktop = the playground source behind a platform seam — the structural precedent); ADR-0059 (brain disclosure); ADR-0006 (runner CSP); T1's measurements (`tasks/done/INDEX.md` 2026-09-05 + the parent's "Decisions & surprises"): OPFS/localStorage quota at the artifact origin, the embedder-narrowed CDN allowlist, `sample` on `quick`, the html-republish custody ladder, S7's 149 KB widget floor

## Spec (what & why)

**What.** A new app, `apps/host`, built the way `apps/desktop` is built — the playground's own React source aliased in as `@playground`, an entry that installs a platform object before React boots, its own Vite config — whose build emits two self-contained single-file pages: **`snug-host.html`** (the full kit: hub → run view → a settings subset, the twelve starters, the user database on sql.js with the WASM inlined as bytes, import/export; **no builder chat, no brain/model/provider/account controls — D15**) and **`snug-host-micro.html`** (a ≤ 80 KB vanilla runner shell for the widget binding, no sql.js, no React). At boot the full kit runs a **probe** that decides the binding (`artifact` / `artifact-chat` / `local-host` / `file`) and picks the brain and the storage from T1's measured ladder; in this task only the arms that need nothing from a host are implemented (demo brain; OPFS → IndexedDB → memory storage) and the host-specific arms (`sample`, `window.claude.complete`, the html-republish and `window.storage` backends, the local-host boot config) are typed seats that T3/T4 fill. The playground gains capability flags that hide surfaces, so the kit is the playground's own components with less, never a parallel UI (parent AC4). A root gate, `check-host-kit`, pins the kit's size and self-containment.

**Why.** Every binding of the program runs this page: it is what the skill publishes as the `Snug` artifact (T4), what `snug-host.mjs` serves is its sibling the ordinary playground (T3), and what the widget carries is its micro form (T5). T1 answered the questions that shape it: the nested runner works inside both artifact viewers, the WASM cannot be fetched there (`connect-src 'self'`), the CDN allowlist is narrower than the runner's, and the durable store is a republish of the page itself — so the kit must be one file, carry its engine as bytes, and know which host it woke up in.

**Acceptance criteria** (each becomes at least one test; "walk" = a journaled manual check where no test can reach):

1. **One file.** `apps/host/dist/snug-host.html` contains no external `<script src>`, `<link rel="stylesheet">`, `@import`, or boot-time `fetch`/XHR to any origin; opened from `file://` it renders the hub with the starter shelf (Playwright smoke with every network request aborted; a dist sweep with comments stripped; size ≤ 16 MiB).
2. **Persists.** Served over http at an origin with OPFS, installing a starter survives a reload (Playwright); at an origin without OPFS the probe falls to IndexedDB, then memory, and says so (unit matrix over `detectPersistenceBackend`'s branches).
3. **Runs.** Chess plays a move against the demo brain inside the kit, with the app's React loaded from jsDelivr `/npm/` — the only external host the smoke allows (Playwright; every other request aborted and asserted absent).
4. **Nothing to choose (D15).** With the host platform: no `build` link, no create bar on the hub, no brain section in Settings (only your file / appearance / about), no `ModelSelect`, connections door, share control, feedback menu or identity chip anywhere; with the web platform every one of those still renders (vitest render tests, positive twins included).
5. **Disclosure only.** The brain chip renders "demo brain — no host brain wired yet" in the kit (T2's only brain) with no switch links; copy byte-pinned beside `BrainChip`'s existing pins.
6. **Honest flags.** `host-ready.capabilities` from the kit reports `db:true`, `auth:false`, `net:false`, `openUrl` per the wired seam, and `streaming` from a new runner host option (`streaming?: boolean`, default `true`, so every existing embedder is byte-identical) — runner unit tests for the option; the kit's e2e reads the frame through the inspector.
7. **Sandbox unchanged.** The runner's CSP injection and `sandbox="allow-scripts"` are not touched; the playground's CSP e2e checks run once with the kit as the embedder and pass (the fixture server gains a `/kit/` prefix over `apps/host/dist`).
8. **Micro shell.** `snug-host-micro.html` ≤ 80 KB alone; with S7's compiled `quiz-me` embedded it stays ≤ 262,144 chars, renders the app, and announces `db:false` (state-in-page is T5's); Playwright smoke. If `@snugprotocol/runner` + `protocol` cannot fit 80 KB as-is, the number is journaled and T5 owns the diet — the AC then reads "measured, not met".
9. **Engine from bytes.** `packages/db`'s driver accepts `wasmBinary` (bytes) beside `locateWasm`; with both, `wasmBinary` wins and `locateWasm` is never called; every existing db suite stays green.
10. **Parity.** Screenshots of the kit's hub and run view beside the playground's at the same width are journaled (walk; Playwright captures both).
11. **Gates.** `check-host-kit` joins the root `test` chain and `gate-local`'s workspace leg; `pnpm --filter host test` and the desktop suite are green (the new flags default to "on" by absence, so desktop and web are byte-for-byte unchanged).
12. **Docs.** `architecture.md` (a "Host kit" box + dependency-graph row), `code-map.md` rows, `glossary.md` ("host kit", "binding", "probe"), `apps/host/dist` gitignored in the same commit; ADR-0065 unchanged (still proposed; nothing here decides beyond D1/D15).

**Out of scope (owned elsewhere):** the `sample` / `claude-complete` transports and the `artifact-html` / `artifact-db` / `window-storage` backends, the "your file" chip, the app hand-in and `snug-embed` (T4); the local-host launcher and its boot config, the bearer for `local` mode (T3); the `WidgetBridge`, `snug-db`, the pre-compile step (T5); publishing or deploying the kit anywhere; the `Snug` artifact recipe and favicon (T4/T6); any `packages/protocol` change; the WebLLM brain (excluded from the kit by an alias stub — it would add 6 MB and needs WebGPU).

## Plan

### Design decisions (Gate 2, grounded in the code read on 2026-09-05)

- **P1 — Structure.** Mirror `apps/desktop` exactly: `apps/host/vite.config.ts` aliases `@playground` → `../playground/src`; `src/main.tsx` sets the platform then mounts `<HashRouter><App/></HashRouter>` (a single file has no server, so hash routing, as the desktop's `tauri://` does); `src/platform-host.ts` supplies the seats. The dependency direction stays host → playground; the playground never imports from `apps/host`.
- **P2 — Capability flags, absence = on.** `SnugPlatform.capabilities` gains `builder?`, `brainSettings?`, `connections?`, `feedback?`, `share?` (optional booleans; `undefined` means enabled — the `hubAuth?` seat's own rationale in `platform.ts`, inverted, so every test-constructed platform and the desktop stay on today's behaviour without a seat edit). One helper, `allows(name)`, reads them (`capabilities[name] !== false`) so no call site re-spells the default. `kind` widens to `'web' | 'desktop' | 'host'`; a new optional `binding?: 'artifact' | 'artifact-chat' | 'local-host' | 'file'` seat records what the probe found (for the chip's provenance, never for logic branches the flags should carry).
- **P3 — Gating sites** (each a one-line conditional on `allows(...)`): `App.tsx` — the `build` NavLink and `/build` route (`builder`), `FeedbackMenu` (`feedback`), the `/download` route (`kind !== 'host'`), `/s/:id` (`share`); `HubView.tsx` — the create bar + suggestion chips (`builder`; the hero copy under the host platform says the agent builds here); `SettingsView.tsx` — the `brain` section (`brainSettings`), `connections` (`connections`), `feedback` (`feedback`); `RunView.tsx` / `RunHeaderActions.tsx` — `ModelSelect` (`brainSettings`), the connections door (`connections`), share (`share`); `BrainChip.tsx` — the popover's switch links (`brainSettings`), and the kit's own copy variant for the `demo` kind with a host binding. `IdentityChip` and `AccountCard` already vanish under `hubAuth` off; sync origins under `hubSyncOrigin` off.
- **P4 — Engine bytes.** `packages/db/src/driver.ts`: `CreateDbDriverOptions.wasmBinary?: ArrayBuffer | Uint8Array`; at the `initSqlJs(config)` site, `wasmBinary` (when present) is passed as Emscripten's `wasmBinary` and `locateFile` is omitted (sql.js 1.14.1 honours `Module.wasmBinary` — verified in its bundle). The kit gets the bytes from a 15-line Vite plugin that answers `import wasm from 'sql.js/dist/sql-wasm.wasm?base64'` with a string module (no new dependency; the dependency policy would otherwise want an ADR); `apps/host/src/wasm.ts` decodes it once. The playground's `run/wasm.ts` (`?url`) is untouched. A `data:` URL through `locateFile` was rejected: Emscripten fetches it, and the hosted viewer's `connect-src 'self'` would block the fetch (T1's S1 CSP).
- **P5 — Single file.** A second small Vite plugin in `apps/host/` inlines the entry's JS as `<script type="module">` and its CSS as `<style>` into the emitted HTML and drops the asset files; `build.rollupOptions.output.inlineDynamicImports: true` folds RunView's lazy chunk and the starter `?raw` chunks in; `@mlc-ai/web-llm` is aliased to `src/stubs/webllm.ts` (throws a named error) so the 6 MB engine never enters the bundle. Estimated full kit ≈ 3.5 MB (1.2 MB app JS + ~1 MB starter html strings + 0.9 MB WASM base64 + CSS). Vite's own emitted `<head>` is enumerated from a real build before the plugin is written (lesson 2026-08-25).
- **P6 — Probe.** `apps/host/src/probe.ts` is a pure function `decideBinding(env) → { binding, brain, storage }` over an `env` the entry gathers (`claude.use` present? flat `window.claude.complete`? `window.storage`? OPFS? a `/snug-host.json` boot config?), unit-tested as a matrix. T2 wires: `brain: 'demo'` for every binding (the only brain that exists yet) and `storage: opfs | idb | memory` through `detectPersistenceBackend`; the `sample` / `complete` / `artifact-html` / `window-storage` / `local` arms return typed `unavailable` seats that T3/T4 replace. The probe never asks the user anything (D15). The brain chip's `brainKind` provenance is stamped from the probe's result per turn (lesson 2026-08-26).
- **P7 — Streaming truth.** `packages/runner`: `RunnerHostOptions.streaming?: boolean` (default `true`) feeds `postHostReady`'s `capabilities.streaming`; nothing else in the runner changes. `db`/`net`/`openUrl` already follow the seams supplied.
- **P8 — Micro shell.** `apps/host/src/micro/main.ts` is vanilla: `createRunnerHost` over an iframe, the demo transport from `@snugprotocol/adapters`' mock adapter, no `db`, a status line; the app html arrives as a `<script type="text/plain" id="snug-app">` block (S7's embed convention, `</script` escaped reversibly). Measured against the 80 KB target; the WidgetBridge is T5's.
- **P9 — Gate.** `scripts/check-host-kit.mjs` (+ `check-host-kit.node-test.mjs`, so vitest does not collect it): reads `apps/host/dist/*.html`, fails on size (16 MiB / 80 KB), on any `<script src`/`<link rel="stylesheet"`/`@import`, on any `https?://` string outside `packages/protocol`'s `CDN_ALLOWLIST` + the site links `config/site.ts` already single-homes (comments stripped first — lesson 2026-08-27), and on a missing build stamp (`<!-- snug-host <package version> <git sha> -->` written by the inliner). Joins the root `test` chain after `check-website-sync`, and `gate-local.mjs`'s workspace leg (lesson 2026-08-24: the leg does not run root `check-*` seats by itself).
- **P10 — Verification surfaces.** `apps/host/e2e/kit.spec.ts` (own minimal `playwright.config.ts`; serves `dist/` from a loopback static server; aborts every request except jsDelivr `/npm/`; also opens the file directly): AC1/2/3/6/8 + screenshots for AC10. The CSP checks (AC7) run by adding a `/kit/` prefix to `apps/playground/e2e/fixtures/server.mjs` and a `csp-kit` case that embeds the same probes inside the kit's app frame.

### Files to touch, in order (tests first at every step — [TDD.md](../../engineering/TDD.md))

1. `packages/runner/src/host.ts` + `src/__tests__/host-ready.test.ts` — `streaming?` option (P7). Run `runner` + dependents (`playground`, `server`, `adapters`, `db`, `sdk`).
2. `packages/db/src/driver.ts` + `src/__tests__/driver-wasm-binary.test.ts` — `wasmBinary` (P4; the test reads the real `sql-wasm.wasm` bytes and opens a DB with no `locateWasm`; a spy proves `locateWasm` is never called when both are given). Run `db` + `sdk`, `playground`, `auth`.
3. `packages/knowledge/src/assemble.ts` + test — `HostPlatform` gains `'host'`; assembly for `'host'` is byte-identical to `'web'`.
4. `apps/playground/src/platform/platform.ts` (+ `allows`), then the gating sites in P3 with `src/__tests__/hostCapabilities.test.tsx` (render `App`, `HubView`, `SettingsView`, `RunView` header under a host platform and under the web default — negative + positive twins), `brainChip.test.tsx` copy pin. Run `playground` + `desktop`.
5. `apps/host/` scaffold: `package.json` (`name: host`; `build`: `tsc --noEmit && vite build`; `test`: `tsc -p tsconfig.test.json && vitest run`; `test:e2e`), `tsconfig*.json`, `vite.config.ts` (P1/P4/P5), `src/plugins/{wasm-base64,inline-single-file}.ts` with `src/__tests__/plugins.test.ts` (round-trip against fixture bundles), `src/probe.ts` + `src/__tests__/probe.test.ts` (matrix), `src/platform-host.ts` + test (kind, binding, every flag off, storage seat from the probe), `src/main.tsx`, `src/stubs/webllm.ts`, `index.html`, `micro.html`, `src/micro/main.ts` + a size test.
6. Build; enumerate Vite's emitted head; finish the inliner; `scripts/check-host-kit.mjs` + node-test; root `package.json` + `gate-local.mjs`; `.gitignore`.
7. `apps/host/e2e/kit.spec.ts` + `playwright.config.ts`; the playground fixture `/kit/` prefix + `csp-kit` case.
8. Screenshots + journal (AC10); docs (AC12); `/close-session`.

### Cross-package impact ([architecture.md](../../architecture.md) dependency graph)

`runner` → run `playground`, `server`, `adapters`, `db`, `sdk`, `host`. `db` → `sdk`, `playground`, `auth`, `host`. `knowledge` → `server`, `playground`, `desktop`, `sdk`. `playground` source → `desktop` (alias consumer) and `host`. New app `host` consumes the playground source + all seven packages, like `desktop`; add its row to the graph.

### Test plan summary

| AC | Test | Where |
|---|---|---|
| 1 | dist sweep (comments stripped) + size + `file://` smoke with all requests aborted | `check-host-kit`, `apps/host/e2e/kit.spec.ts` |
| 2 | install-starter-then-reload over http; `detectPersistenceBackend` fallback matrix | e2e; `apps/host/src/__tests__/probe.test.ts` |
| 3 | chess move on the demo brain; only jsDelivr `/npm/` requested | e2e |
| 4 | render tests with host vs web platforms (negative + positive twins) | `apps/playground/src/__tests__/hostCapabilities.test.tsx` |
| 5 | byte-pinned chip copy for the host demo variant | `brainChip.test.tsx` |
| 6 | `streaming` option default/explicit; the kit's host-ready read through the inspector | `packages/runner` test; e2e |
| 7 | CSP probes inside the kit's app frame | `apps/playground/e2e/csp.spec.ts` (`csp-kit`) |
| 8 | micro shell size; quiz-me embedded ≤ 262,144 chars; `db:false` announced | size test; e2e |
| 9 | `wasmBinary` opens a DB; `locateWasm` unused when both given | `packages/db` test |
| 10 | screenshots journaled | walk |
| 11 | root `pnpm test` incl. `check-host-kit`; desktop suite | gates |
| 12 | docs rows exist (review) | review |

Mutation checks before Gate 5 (lesson 2026-08-04): remove the `streaming` option → the runner test reds; hand the driver only `locateWasm` → the wasmBinary test reds; flip one flag default → the corresponding gating twin reds; inject a `<script src="https://x">` into the built kit → `check-host-kit` reds.

### Lessons that bite here (from the parent's appendix)

Run vitest from the package dir; pin any `VITE_SNUG_*` by `vi.mock`; `rm -rf dist` + `--force` before any size number; enumerate Vite's emitted head from a real build; a source scanner strips comments; gitignore the output dir in the same commit; every negative reachability check owes a positive twin; provenance stamped at the decision; a green run is not a rendered surface — the e2e opens the real file.

### Spec-sync

None. If Gate 3 finds a reason to touch `packages/protocol`, stop and re-tier (SPEC_SYNC).

## Decisions & surprises

- **2026-09-05 — the WASM cannot ride a `data:` URL.** Emscripten resolves `locateFile` with a fetch; the hosted viewer's `connect-src 'self' …` (T1 S1) would block a `data:` URL. Bytes through `wasmBinary` are the only path — hence P4.
- **2026-09-05 — `inlineDynamicImports` would drag WebLLM in.** `agent/webllm/engine.ts` `import()`s `@mlc-ai/web-llm` lazily; a single-file build inlines every dynamic import, so the engine is aliased to a stub in the host build (P5).
- **2026-09-05 — no `platform` seat on `host-ready`.** Apps already degrade on the flags they read; the parent left the seat as a Gate-2 candidate and this plan declines it (no consumer, a High spec change).

## Session journal (append-only, newest last)

### 2026-09-05 08:00 UTC — Jeetu (via Claude Code) — session (Gate 1–2)
- Done: task file from the parent's T2 spec + T1's measurements; code facts re-verified (sql.js 1.14.1 `wasmBinary`; the desktop's Vite config and entry; `capabilities` read at 7 sites; `App.tsx` header/routes; Settings sections; `initWebllm` at boot with a lazy engine import; the playground e2e fixture server's `/pkg/` prefixes). T1 moved to `done/INDEX.md` on this branch.
- State: **awaiting plan approval**; a fresh-context plan review (High tier) runs next and its findings are folded here before the ask.
- Next step: on approval → Gate 3, step 1 (runner `streaming` option, tests first).
- Open questions: none beyond the S1 third path the parent already flags (nested runner + narrowed CDN rule) — T2 does not depend on it.
