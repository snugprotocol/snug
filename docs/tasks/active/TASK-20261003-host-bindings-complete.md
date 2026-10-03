# TASK-20261003-host-bindings-complete: Host bindings, complete — Binding B on Claude Desktop, the brain registry with Codex, Binding A2 production-ready, one kit, capability-true shelves

- **Status**: planned (Gate 2 — the owner delegated plan approval in the ask itself: "make your own decisions … keep running and deliver all"; the High-tier fresh-context plan review stands in for the interview and is folded below before any implementation code)
- **Owner**: Jeetu (via Claude Code)
- **Risk tier**: **High** — a brain that can use tools is a principal the sandbox does not bound (C1/C2 by another door), the child env (C1), the kit's boot/binding decision, CI/gate scripts. `packages/protocol` and `packages/runner` are NOT touched.
- **Branch**: `feat/TASK-20261003-host-bindings-complete` (off `main` @ `720b632`)
- **Packages touched**: `apps/host-mcp`, `apps/host`, `apps/playground`, `packages/knowledge` (the skill source + two KB lines), `scripts/` (plugin build, gates, npm layout, bootstrap), `docs/`
- **Spec impact**: none — no schema in `packages/protocol` changes (brain ids, the host passport and the availability derivation are host-side; the per-machine brain choice never enters the user file, ADR-0070 §5). T7's non-normative appendix stays owed by the program.
- **Related**: program record [TASK-20260904-skill-only-snug](TASK-20260904-skill-only-snug.md) (T3 remainder, the chat-delivery child, walk #2) · ADR-0065 · ADR-0066 · ADR-0067 · ADR-0068 · ADR-0069 · ADR-0070 · **ADR-0071 (this task — the brain registry)** · **ADR-0072 (this task — one kit, every binding; capability-true shelves; the chat delivery)** · `docs/next-steps.md` 2026-09-13 / 2026-09-08 / 2026-09-06 entries

## Spec (what & why)

Snug's promise on this program is "your apps run inside the agent you already have". Today that is true for one agent on one surface: Claude Code in a terminal. This task makes it true across the board, and makes the product say only true things on every surface:

1. **Binding B under Claude Desktop** (walk #2). The plugin's local runner must start and be usable from the Cowork tab and the Code tab — a GUI-spawned process with no shell PATH, next to a terminal session that may already hold the runner.
2. **Another agent the user already has can be the brain** (ADR-0069's second axis): one brain contract and a registry, with `codex` beside `claude` — a brain, not a binding. **Scope set by the owner mid-session (2026-10-03): "skip the ollama for now … and also skip the OpenClaw and hermes for now"** — those three drivers and the Hermes walk (S5) are deferred to their own task; the registry is built so each is a file.
3. **Binding A2 (claude.ai chat / Claude Desktop chat) becomes a production path**: the kit boots where a chat artifact runs, its brain (`window.claude.complete`) has a measured-or-learned prompt budget instead of an assumed one, and the chat delivery (the script build, the npm layout, the bootstrap, the skill recipe) ships.
4. **One runner, not one per binding**: one kit page, one boot, one capability table, one hand-in path, one brain contract — the web/desktop/kit parity ADR-0021 established, extended to every binding.
5. **A host never offers what it cannot run**: starter apps and installed apps whose needs the current binding cannot meet are disabled, each with the true reason and where it does run.

**Found while planning (2026-10-03), fixed here because walk #2 cannot pass without them:**

- **The attach path is dead in the shipped build.** `runner.ts:138` wires `commandLineOf: () => undefined`, so `lock.ts` classifies every live holder as a stranger and refuses; `main.ts` then dies before the MCP handshake. Reproduced on the owner's Mac: this very session's `plugin:snug:snug` failed with "Connection closed" while a healthy runner (pid 92272, `clients: 1`) held the lock. "Two windows, one Snug" has only ever worked in tests, which inject the command line.
- **An attached session cannot hand an app in** (`runner.ts:219-244` forwards only `snug_status`/`snug_open`).
- **`absent` does not fall back to the demo brain**: the chip says "demo brain", the seat still routes to the shim, every think is a 502.
- **Binding B hand-ins never reach the hub or the user**: `local/main.tsx` dispatches three `CustomEvent`s nobody listens to; there is no `agentHandIns` seat; `snug_list_apps` is a stub.
- **The only starter gate is a hard-coded `desktopOnly` table** checked against `kind !== 'desktop'`, with one reason string that is wrong for two of the three starters it locks, wrong under Binding B (where the process, not a browser, carries the request), and absent for installed apps and for the run route.
- **The kit would likely crash at a real chat origin**: `main.tsx:39` reads `sessionStorage` unguarded, which throws at an opaque origin; the chat e2e serves the page from loopback http, never from `about:srcdoc`.

### Owner decisions taken on the owner's behalf (each reversible by one word; recorded in the ADRs)

| # | Decision | Default taken | Why |
|---|---|---|---|
| Q1 | Gate 2 approval | delegated by the ask | "make your own decisions … keep running"; the fresh-context plan review is the control |
| Q2 | How a brain is chosen | `auto` (the host that spawned the runner, else the first ready brain) + a per-machine pin among READY brains on the chip | D15 says the kit never *asks*; a pin among brains the machine already has asks for nothing (no key, no URL, no account) — ADR-0067/0070's precedent |
| Q3 | Brains that can use tools | **never** an app brain — every brain answers tool-free by construction or is listed with the reason and not selectable | D5 generalised: an app's think is untrusted input; a brain with a shell is a way out of the sandbox |
| Q4 | Two kit builds | **one page** for artifact, chat, file and loopback; the binding is a runtime fact | measured: the two pages are the same size; the second build is a restated config, a second gate target and 2.26 MB of plugin |
| Q5 | Connected starters where connections do not exist | **disabled with the reason** (was: "runs in its sample mode") | owner's item 5; the sample-mode claim is false for `weather` |
| Q6 | The unmeasured `complete` cap | a conservative default + a learned cap + an explicit, disclosed "measure" act; never an assumed number | the cap can only be measured inside claude.ai; a product that depends on one unrecorded walk is not production-ready |
| Q7 | A `.mcpb` desktop extension | **not built** | Cowork + the Code tab are Claude Desktop's plugin surfaces; the directory no longer lists extensions; the chat tab gets the skill and the artifact route |
| Q8 | The `local-host` rename | stays its own PR (ADR-0069 §3) | this task only makes the runner's identity string rename-proof |
| Q9 | Live walks | real `claude` (installed, logged in); Codex by fixtures RECORDED from the real CLI 0.160.0 run logged-out from the session scratch directory (its own `CODEX_HOME`; nothing installed into the owner's machine) + an opt-in live test the owner runs after `codex login` | the program's hard stop is installing agents on the owner's machine; a logged-in Codex is the owner's |
| Q10 | Ollama, OpenClaw, Hermes | **deferred — the owner's instruction mid-session**; read as the drivers AND the walks (S5 included), not only the downloads | "skip … for now"; one word reverses the reading |

**Acceptance criteria** (each becomes at least one test; `→` names the test's home)

*L — runner lifecycle (prerequisite)*

- **L1.** A second process started against a home whose runner is healthy ATTACHES: it completes `initialize`, lists the four tools, and `snug_status` says `attached: true`. Proven by spawning the BUILT release bundle twice (never by injected deps). The lock identifies its own kind by a command-line read through `/bin/ps` by absolute path; the identity string has one home and is pinned against the bundle's file name. → `mcp-interop.test.ts`, `lock.test.ts`
- **L2.** No start failure can precede the MCP handshake. A runner that can neither lead nor attach still answers `initialize`/`tools/list`; `snug_status` returns `{ running: false, refusal: { code, message, remedy } }` and every other tool returns the same sentence as an error. Every refusal a user can provoke is enumerated in one table with a remedy a person can act on. → `runner.test.ts`, `mcp-interop.test.ts`
- **L3.** An attached session can `snug_hand_in` and `snug_list_apps`: both travel the `0600` control socket as their own ops; the bearer never does. → `control-socket.test.ts`, `runner.test.ts`
- **L4.** `snug stop` (the human CLI, over the socket) makes the primary exit cleanly — children reaped, lock released — and `snug status` reports `version`, `pid`, `clients`, the active brain. An attaching session whose build differs from the primary's gets a `note` naming the remedy. → `runner.test.ts`
- **L5.** `snug_open` never crashes the runner: the opener is resolved by absolute path per platform, carries an `error` listener, and a failure returns the printed fallback. `snug open --print` prints the launch URL to the user's terminal without opening anything. → `runner.test.ts`
- **L6.** `snug_list_apps` is real: the open page reports its library (names, lineages, versions — never data) to the process over a bearer-gated route; the tool returns it, marked `stale` when no page is open. → `loopback-server.test.ts`, `local.spec.ts`

*D — Binding B under Claude Desktop*

- **D1.** The gate STARTS what it ships: `check-host-mcp` runs `<tree>/snug/scripts/snug` under an empty environment (`env -i`, cwd `/`), speaks `initialize` + `tools/list` + `snug_status`, then attaches a second process. A bundle that dies at startup is red. → `check-host-mcp.mjs`
- **D2.** The plugin tree satisfies the directory's mechanical pre-submission rules (manifest `name`/`displayName`/`version`/`description`/`author`/`license`; README ≥ 40 words outside code; no `bin/`; no `.DS_Store`/`__MACOSX`; every file < 5 MiB; ≤ 512 files; no package-manager config; `.mcp.json` schema), and the three expected reviewer holds (files over 256 KiB, the `/bin/sh` launcher, the built page) are NAMED in the gate's output and the README rather than hidden. → `build-plugin.test.mjs`, `check-host-mcp.mjs`
- **D3.** `dist/plugin/snug.zip` exists: a deterministic archive of the plugin folder as its single top-level entry (the form **Customize → Plugins → Add → Upload plugin** takes), written by a dependency-free writer, byte-reproducible, re-read and CRC-verified by the gate. → `scripts/lib/zip.test.mjs`, `build-plugin.test.mjs`
- **D4.** When no brain is ready the DEMO brain answers — never a 502 — and the chip says which brains were looked for and the remedy for each. A brain that becomes ready later is picked up without restarting the agent (re-probe on demand and after a failed think). → `brains/registry.test.ts`, `composeLocal.test.ts`, `local.spec.ts`
- **D5.** The desktop-host walk is a script: `scripts/walk-desktop-host.mjs` starts the shipped launcher with a GUI-shaped environment, hands Chess in over MCP, drives the real page in Chromium and takes one move on the real `claude` brain; a second leg hides every brain and asserts the demo fallback and the remedy sentence. Numbers journaled. (Opt-in, never in the gate: it spends the user's subscription.) → journal
- **D6.** The skill and the tool instructions route by surface truthfully: Cowork and the Code tab → the local runner; the chat tab → the chat runner (A2); the "no runner" line names the install path that exists on that surface. → `skill.test.ts`
- **D7.** The owner's Cowork walk is printed as numbered steps with the expected observation at each; its result is journaled when walked.

*B — brains (ADR-0071)*

- **B1.** One brain contract (`brains/brain.ts`: `BrainDriver { id, name, via, probe(), catalog(), create() }`), one registry, one readiness vocabulary (`ready | logged-out | outdated | absent | unknown`). `claude` is its first driver, behaviour-identical: the frozen argv literal, the pool key, the env allowlist and every existing brain test pass unchanged (characterization first). → `brain-claude.test.ts`, `brains/registry.test.ts`
- **B2.** `/status` and the `status` event carry `brains[]` (id, name, via, state, detail, models, efforts, streaming) and `active`; the legacy `brain`/`models` fields keep their meaning (the active brain's, or the hinted brain's when none is ready). The chat route takes an optional `brain` id validated at the envelope boundary (C5); the brain that answered rides `x-snug-brain`. → `loopback-server.test.ts`
- **B3.** `auto` resolves per think: the host hint (`--host <id>` from the manifest that spawned the runner) when that brain is ready, else the first ready brain in the fixed order, else none (D4). A pinned brain that is not ready is not used, and the chip says so. → `brains/registry.test.ts`
- **B4.** **Every driver is tool-free by construction and proves it**: its posture is a frozen literal in a test. No driver passes the parent environment; each child env is the allowlist, and no API-key variable survives it (a hostile parent env fixture). → per-driver tests, `check-host-mcp.mjs` (whole-env read count)
- **B5.** `codex` driver: the user's own Codex CLI as a single-shot child on their ChatGPT login. Readiness from `codex login status` (never from a think); the catalogue from `codex debug models --bundled` (failing soft to no list); the system prompt as the developer instruction, the conversation on stdin; JSONL events parsed at every byte boundary from fixtures RECORDED from the real CLI; the tripwire — a stream carrying any tool-shaped item delivers NO answer and fails by name; `turn.failed`, a 401, a usage-limit sentence and a missing binary each a named result; model + reasoning level chosen from the chip, the levels being the chosen model's own. → `brain-codex.test.ts` (+ opt-in live: `SNUG_LIVE_BRAIN=codex`)
- **B6.** The chip is a brain switcher: every brain the registry knows, its state and remedy; `auto` first; model and thinking-level controls for the active brain from ITS catalogue and vocabulary (no cross-brain mapping invented); what ANSWERED is shown, never what was asked (ADR-0059 rule 2); the choice is per machine, per brain, migrated from the single-brain shape, and never in the user file. → `brainChip.test.tsx`, `brainChoiceStore.test.ts`, `local.spec.ts`

*A — Binding A2 (chat)*

- **A1.** The kit boots at an opaque origin: under a sandboxed `about:srcdoc` frame carrying the measured chat CSP, with `window.claude.complete` and `window.storage` supplied the way the viewer supplies them, the hub renders, an app thinks, state survives a reload. Every storage global is read through one guarded accessor. → `e2e/chat.spec.ts`
- **A2.** The ruler is the sent string: for every shape the chat adapter sends (one turn, a conversation) `measurePrompt` equals the UTF-8 length of the string `complete` receives. → `brains.test.ts`
- **A3.** `complete` cannot hang or lie: it is raced against the caller's abort and a named wall-clock bound; a rejection, an empty reply, a non-string reply and a reply cut short are each a named result. → `brains.test.ts`
- **A4.** The prompt budget is measured, not assumed: the seat's `maxPromptBytes` starts at a pinned conservative default, is lowered when a call fails in the size class, raised only by a proven success, persisted per view, and read per call; the builder budgets-or-refuses on it (ADR-0066's ladder now applies to the chat brain). An explicit **measure** act on the chip runs a disclosed, cancellable ladder of probe calls and records the result. → `promptBudgetStore.test.ts`, `brains.test.ts`, `e2e/chat.spec.ts`
- **A5.** A copyable diagnostics report (runtime shape, cap ladder results, latency per size, storage facts, the nested runner's CSP enforcement signal, build stamp) is the walk's journal entry — the owner pastes one page and clicks once. → `diagnostics.test.ts`
- **A6.** ONE build, two deliveries: `snug-host.js` is derived from `snug-host.html` (the same module bytes plus the page's style, self-mounting), never a second bundle; `check-host-kit` pins the derivation. → `check-host-kit.test.mjs`
- **A7.** The npm layout exists and is validated without publishing: `dist/npm/host/` (`@snugprotocol/host`: `package.json`, `README.md`, `LICENSE`, `snug-host.js`, `snug-host.html`), checked by `npm pack --dry-run --json`. Registering the scope and publishing are printed owner acts. → `build-host-npm.test.mjs`
- **A8.** The bootstrap is generated, small and pinned: `scripts/snug-bootstrap.mjs` emits a page of at most 60 lines that loads the kit from jsDelivr `/npm/` at an exact version with `integrity` + `crossorigin`, carries the app bundles, and says what is wrong when the kit cannot load. → `snug-bootstrap.test.mjs`, `e2e/chat.spec.ts` (CDN route stubbed)
- **A9.** The skill carries the chat recipe: detect the chat surface, build the bundle with the skill's script (no hand-escaping), deliver by file where the chat can present one and by bootstrap otherwise, say where the data lives ("publish the artifact to keep its data"), never claim a connection. Text pinned. → `skill.test.ts`
- **A10.** C2 inside chat: in the chat harness the app frame keeps `sandbox="allow-scripts"`, a probe app's `fetch` raises `securitypolicyviolation`, and reaching for `parent`/`top` throws. → `e2e/chat.spec.ts`

*K — one kit*

- **K1.** `apps/host` has ONE Vite config, ONE html entry and ONE output page; `vite.local.config.ts`, `local.html` and `dist-local/` are gone; the local process serves `snug-host.html`; the plugin ships that page once. A structural test fails on a second config or entry. → `plugins.test.ts`, `check-host-kit.mjs`
- **K2.** The binding is decided once, at runtime, by one function: `local-host` means a runner answered `/status`; a loopback static server is file-class and its custody copy says so. → `probe.test.ts`
- **K3.** One boot path, one capability table (`hostCapabilities()` — no hand-written capability literal outside it), one custody store, one hand-in core serving DOM blocks (A) and runner events (B). Binding B gains the pending-update offer; an arriving app appears on the hub without a reload and its note reaches the user; the three dead `CustomEvent`s are deleted. → `compose.test.ts`, `handin.test.ts`, `local.spec.ts`
- **K4.** No duplicated helper survives: one guarded storage accessor, one base64, one "connections are not available here" sentence. → the lint test in `plugins.test.ts`

*S — capability-true shelves*

- **S1.** ONE derivation (`platform/availability.ts`): what an app NEEDS (from its connection requirement or its connection rows: network, a browser-uncallable provider, OAuth, a LAN device, the helper) × what the host OFFERS (from the platform's seats) → `available` or blockers, each with a title, a sentence and where it runs. Pure; matrix-tested over every starter × every binding. → `availability.test.ts`
- **S2.** Starter tiles are disabled exactly when the derivation says so, with the true reason; the hard-coded `desktopOnly` flag is deleted. Under Binding B, Trade Copilot is enabled; Moodboard and Telepath are disabled for their own reasons. Under an artifact every connected starter is disabled. → `starterShelf.test.tsx`, `kit.spec.ts`, `local.spec.ts`
- **S3.** Installed apps obey the same rule: a tile whose app cannot run here is disabled (rename, delete and export stay), and the run route refuses with the reason for starters and installed apps alike — no bypass by URL. → `hubAvailability.test.tsx`, `kit.spec.ts`
- **S4.** The wizard's walls and the browser-wall disclosure read the same derivation; no `kind !== 'desktop'` capability check remains in `apps/playground/src`. → `availability.test.ts`, a source lint
- **S5.** A host passport on the chip row: what this host can and cannot do, in words, derived from the same table. → `hostPassport.test.tsx`
- **S6.** Every new surface is screenshot-reviewed in both themes at desktop and 375 px, with a `scrollWidth` tripwire. → `kit.spec.ts`

**Out of scope**: **the `ollama`, `hermes` and `openclaw` drivers and the Hermes walk S5 (deferred by the owner, 2026-10-03 — ADR-0071 records the rule they must meet: a gateway that answers with its tools on is never an app brain; Ollama through the native route so the window is sized per request)**; the `host-mcp` → `local-host` rename (its own PR, ADR-0069 §3); Codex/ChatGPT plugin packaging and directory submission (T9); Binding C / the micro kit (T5); the MCP-connector binding for artifacts ("Binding A-connected") and S12 (the agent as the brain over tool calls); page tools for the `sample` brain (ADR-0066 A9); a `.mcpb` extension; transcript continuation; LAN and helper seats on Binding B; `npm publish`, the scope registration, any GitHub Release, any directory submission, installing an agent into the owner's machine, driving the owner's logged-in claude.ai (owner acts — prepared and printed, never performed); the T7 spec appendix.

## Plan

Approved by delegation (see Status); amended by the plan review before any implementation code. Decisions: [ADR-0071](../../decisions/0071-the-brain-registry.md), [ADR-0072](../../decisions/0072-one-kit-every-binding.md).

### Facts the plan stands on (2026-10-03)

- **Machine**: `claude` 2.1.288 (nvm), logged in; `codex`, `hermes`, `openclaw`, `ollama` absent; Claude Desktop 2.19675.0 with `claude-code-vm/2.1.286`; 5.5 GiB of disk free; a dev runner (pid 92272, from `dist/plugin`) and a month-old orphan (pid 47631) are alive — neither is touched by this task's tests, which run under `SNUG_HOME=<tmp>` only (D-B34).
- **Plugins on Claude's surfaces** (claude.com/docs/plugins/platform-support + /build, read 2026-10-03): skills load in chat, Cowork and Claude Code; "a local MCP server, one the app starts as a command, loads in Claude Code and in Cowork sessions that run on the person's computer; chat ignores it"; a top-level `bin/` stops chat/Cowork installing the plugin; chat/Cowork installs attach to the claude.ai account (**Customize → Plugins → Add → Upload plugin** takes a zip of the folder, ≤ 200 MB / 5,000 files; **Add marketplace** takes a repo URL) and sync down to Claude Code; the Code tab is Claude Code and shares its installs. The directory's validator blocks on README < 40 words, a missing license, `.DS_Store`/`__MACOSX`, files ≥ 5 MiB; it HOLDS for a reviewer on any non-image file > 256 KiB, > 512 files, a server started "through a shell", and code it cannot read (our launcher, bundle and page are all three — expected, named, not hidden).
- **Codex**: measured on the real CLI 0.160.0, logged out, from the scratch directory — ADR-0071's context has the numbers; the recorded outputs (`exec --help`, `features list`, `login status`, `debug models --bundled`, a logged-out `exec --json` run) become the driver's fixtures. A successful turn is NOT measured (needs the owner's login).
- **Chat runtime**: see ADR-0072's context (T1's S1/S2/S10 pastes, in git at `65a009f^`).
- **Baseline**: root `pnpm test` on `main` @ `720b632` exits 0.

### Contracts pinned BEFORE fan-out (one commit, by the orchestrating session)

1. **Platform seats** (`apps/playground/src/platform/platform.ts`) — types only, no behaviour:
   - `PlatformBrain` (host arm): `cliModel?: CliModelSeat` is REPLACED by `brains?: BrainSwitchSeat` (one seat for every child/gateway brain; Claude's catalogue is its first entry) and gains `budget?: PromptBudgetSeat` (the chat brain). `label`, `maxPromptBytes`, `streaming` stay and are read per render/call (the host supplies getters).
   - `BrainSwitchSeat { state: Store<BrainSwitchState>; choose(id | 'auto'); setModel(model?); setEffort(effort?); recheck(): Promise<void>; note }`, `BrainSwitchState { choice; active?; host?; brains: BrainOptionView[]; model?; effort?; activeModel?; refusal?; checking }`, `BrainOptionView { id; name; via; state; detail?; models; efforts; streaming }`, `BrainReadyState = 'ready' | 'logged-out' | 'outdated' | 'absent' | 'unknown'` (a later driver appends a state; nothing here anticipates one).
   - `PromptBudgetSeat { state: Store<{ maxPromptBytes; source: 'default' | 'learned' | 'measured'; measuredAt? }>; measure(opts: { onStep; signal }): Promise<BudgetReport>; report(): string }`.
   - `capabilities.nativeFetch?: boolean` (a non-browser transport carries connected fetches: desktop and the local runner) and `capabilities.oauth?: boolean` (absent = available; the runner sets `false` when its fixed port was taken).
   - `platformSignals` (`platform/signals.ts`): `brainRevision`, `libraryRevision`, `hostNote` stores + `bump…()`; `useBrain`/the hub/the custody chip subscribe. Replaces the three dead `CustomEvent`s.
2. **The runner's status wire** — ONE fixture (`apps/host-mcp/src/__tests__/fixtures/status-wire.json`) read by the process's route test and the page's client test: `{ binding, port, pages, heldBy?, version, build, host?, oauth, brains: BrainStatusWire[], active?, brain?, models }` (legacy `brain`/`models` = the active brain's). Chat route body gains `brain?: BrainId | 'auto'`; the answering brain rides the response header `x-snug-brain` and the final chunk's `model`.
3. **Availability** (`apps/playground/src/platform/availability.ts`): `type Need = 'network' | 'native-fetch' | 'oauth' | 'lan' | 'helper'`; `needsOfRequirement(req)`, `needsOfConnections(rows)`; `offersOf(platform)`; `availabilityOf(needs, offers): { ok: true } | { ok: false; blockers: Blocker[] }` with `Blocker { need; title; sentence; runsIn: ('desktop' | 'runner' | 'web')[] }`.

### Workstreams, files, order

**Phase 1 — foundations (two tracks, disjoint packages)**

*P1-A · `apps/host-mcp` — lifecycle + the brain contract (L1–L6, B1–B3, D4 process half)*
- `lock.ts` + new `identity.ts` (`RUNNER_IDENTITY`, pinned to `plugin-manifests.mjs` `BUNDLE_PATH` by test); `runner.ts`: real `commandLineOf` (`/bin/ps -ww -o command= -p`), a `kill` for a wedged primary, refusal → a degraded runner (never a throw); `main.ts`: handshake first, `stop` / `status` / `open --print` CLI, the opener table; `control-socket.ts`: `hand-in`, `list-apps`, `stop` ops (+ `version`/`build` in `hello`).
- `brains/brain.ts` (the contract, moved out of `brain-claude.ts`), `brains/registry.ts` (drivers, host hint, `auto` ladder, re-probe with a floor between probes, `statuses()`), `brains/claude.ts` (today's code behind the driver — the pool and `ClaudeChild` stay Claude's: Codex is single-shot with whole-message output, so nothing is generalised that only one driver uses). `loopback-server.ts`: `/status` wire, `brain` on the chat body (validated), `x-snug-brain`, `POST /library`, `POST /brains/recheck`.
- Tests FIRST: characterization (the frozen argv, pool key, env allowlist unchanged); L1 by spawning the built bundle twice under `env -i`; L2 table-driven refusals; the registry matrix (hint ready / hint not ready / none ready / pinned-not-ready).

*P1-B · `apps/host` + `apps/playground` — one kit (K1–K4, A1's storage half, D4 page half)*
- Delete `vite.local.config.ts`, `local.html`, `dist-local`; `main.tsx` becomes the one boot (`claimTokenFromFragment` → `detectRunner` → local or probed composition → `mountKit`); `probe.ts` `decideBinding` takes the runner fact; `platform-host.ts` → `hostCapabilities()` (the four literals collapse); one `custodyStore`; `handin.ts` exposes `applyAgentBundles` used by DOM blocks and runner events, Binding B gets `agentHandIns`; `safeStorage.ts` (the one guarded accessor; `main.tsx`, `probe.ts`, `compose-local.ts` use it); the dead events → `platformSignals`; the no-brain case pins the demo brain for real.
- `apps/host-mcp/src/main.ts` `readPage` candidates and `apps/host/e2e/local-setup.ts` follow the one page (the only cross-track edit; P1-B owns it, P1-A leaves `readPage` alone). `scripts/build-plugin.mjs` ships the page once (`skills/snug/assets/snug-host.html`; the process reads it from there).
- Tests FIRST: the structural test (one config, one entry); `decideBinding` matrix incl. loopback-static = file-class; capability-literal lint; hand-in parity (the same bundle through both sources yields the same store state); a hub that shows an arriving app without a reload (e2e).

**Phase 2 — features (five tracks, disjoint files; no builds or e2e runs inside a track — unit suites only; the integration pass runs builds and browsers serially)**

*P2-A · the Codex brain (B4, B5)* — `apps/host-mcp/src/brains/codex.ts` (+ `codex-events.ts`, the JSONL reader and the tripwire), `install-roots.json` (where a Codex install lives), `check-host-mcp.mjs`'s whole-env count, the recorded fixtures under `__tests__/fixtures/codex/`. Every stream fixture is replayed at every byte boundary (lesson 2026-08-12); the success-path fixture is transcribed from the upstream event source (`codex-rs/exec/src/exec_events.rs`) and MARKED as transcribed, not recorded.

*P2-B · availability + shelves (S1–S6)* — `platform/availability.ts`, `views/HubView.tsx` (the `desktopOnly` flag goes; tiles read the derivation), a route guard in `run/RunView.tsx`, `connections/ConnectionWizardSheet.tsx` + `state/connectionWizard.ts` (walls and the browser-wall line read the derivation), `views/HostPassport.tsx`, `theme/app.css` (tile-locked, reason ribbon, passport). Tests FIRST: the 12 starters × 8 bindings matrix as a table in the test; a source lint that no `kind !== 'desktop'` capability check remains.

*P2-C · chat (A2–A10)* — `apps/host/src/brains/{complete,prompt,promptBudgetStore,diagnostics}.ts`, `probe.ts` (the chat seat: budget + measured cap), `e2e/chat.spec.ts` + `e2e/chat-harness.ts` (the sandboxed-srcdoc harness with the measured CSP and a postMessage-backed `claude`/`storage`), `scripts/build-host-npm.mjs`, `scripts/snug-bootstrap.mjs`, `scripts/snug-bundle.mjs`, `scripts/check-host-kit.mjs`.

*P2-D · plugin, gate, skill (D1–D3, D6, D7, A9)* — `scripts/lib/zip.mjs`, `scripts/build-plugin.mjs`, `scripts/lib/plugin-manifests.mjs` (`displayName`, `--host claude`), `scripts/check-host-mcp.mjs` (start what it ships; the directory rules; the named holds), `scripts/walk-desktop-host.mjs`, `packages/knowledge/prompts/skills/snug/SKILL.md`, `apps/host-mcp/src/instructions.md`, the plugin README.

*P2-E · the brain switcher (B6, the A4 control)* — `views/BrainChip.tsx` (rebuilt: the brain list, the active brain's controls, the measure act), `apps/host/src/local/compose-local.ts` + `brains/brainChoiceStore.ts` (per-brain choice, migrated from the single-brain shape), `theme/app.css` (the dock).

**Phase 3 — integration (serial)**: rebuild from clean (`rm -rf dist`, `--force`), root `pnpm test`, `pnpm --filter host test:e2e` (all projects), the opt-in live leg (the desktop-host walk on real `claude`), screenshots in both themes at 1280 and 375 with the `scrollWidth` tripwire, a design pass on what they show.

**Phase 4 — Gate 5/6**: fresh-context diff review (security, correctness, tests, maintainability, standards; findings adversarially verified), folded; then docs — architecture, code-map (+ counts), glossary, `docs/security/threat-model-delta-brains-and-chat.md` + the ledger rows and hashes (`check-threat-model`), ADR-0065/0068/0069/0070 status lines, the program record's T3 row and D12 table, next-steps pruned, lessons; journal; PR.

### Cross-package impact (dependency graph)

- Playground SOURCE changes (platform seats, hub, run view, wizard, chip) → run `playground`, `desktop` (tsc — the seat rename reaches `platform-desktop.ts` only if it names `cliModel`; it does not) and `host`.
- `apps/host-mcp` serves the kit's page → `host` e2e (`local-host` project) after any change to either.
- `packages/knowledge` (the skill source only; excluded from `content.ts`) → the `knowledge` suite + `check-host-mcp`'s skill render. No KB layer changes beyond the skill, so `gen:content` output is unchanged (asserted).
- `scripts/` → root `pnpm test` is the evidence (lesson 2026-08-24); `gate-local.mjs`'s leg commands and `ci.yml` follow any renamed or added check.
- `packages/protocol`, `packages/runner`, `packages/auth`, `packages/db`, `packages/adapters`: untouched. If a track finds it needs one, it STOPS and reports (a schema or sandbox change is its own decision).

### Test plan (tests first, per TDD.md; High tier → negatives)

- One failing test per AC before its implementation, named in the AC's `→`.
- **C1 negatives**: no child receives a variable outside the allowlist (a hostile parent env fixture with twelve `CLAUDE_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`); the bearer never rides the control socket, a tool result or `/status`.
- **C2 negatives**: the app frame's `sandbox` stays `allow-scripts` on the one page in every harness (file, artifact, chat, runner); a Codex stream carrying a `command_execution` (or any tool-shaped) item delivers NO answer.
- **Mutation checks** on every guard (delete the `ps` read → L1 red; forward a tool item → the tripwire test red; drop the size class → A4 red; restore from `HEAD`, never `git stash`).
- **Rendered surfaces**: the chat harness, the kit and the runner page in a real browser; `securitypolicyviolation` as the enforcement signal; screenshots reviewed.
- **What the suites will NOT prove** (owed walks, journaled): the real Cowork tab; a logged-in Codex (a successful turn, each disabled feature really removing its tool, the developer instruction as the system slot); the real `window.claude.complete` (its cap, latency, truncation), `RUNNER_CSP` inside the real chat frame, `window.storage` before publish; jsDelivr serving the unpublished package.

### Hard stops (owner acts — prepared, printed, journaled, never performed)

Registering the `@snugprotocol` npm scope; `npm publish`; any GitHub Release; creating or pushing `snugprotocol/snug-skill`; the directory submission; installing an agent into the owner's machine; `claude plugin` installs/updates in the owner's Claude; anything in the owner's claude.ai; killing the owner's running runners (pids above — named in the final report with the one-line remedy).

### Self-sign-off (High tier)

Recorded in the journal after the plan review is folded and again after the diff review.

## Decisions & surprises

- 2026-10-03 — see "Found while planning" above; each is an AC.

## Session journal (append-only, newest last)

### 2026-10-03 11:45 UTC — Jeetu (via Claude Code) — session (Gates 1–2)
- Done: task file, branch; five research sweeps (the Binding B process, the kit and its duplication, the A2 state, Cowork/Desktop plugin docs, the four other agents); baseline root `pnpm test` on `main` = exit 0 (turbo 30/30 cached).
- State: planning.
- Next step: fold the brains research into the plan; ADR-0071 + ADR-0072 drafts; the fresh-context plan review; then Gate 3.
- Open questions: none blocking — Q1–Q9 above are defaults the owner may reverse.
