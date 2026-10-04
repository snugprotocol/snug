# Threat-model delta — brains, the one page, and the chat runtime

**Task:** TASK-20261003-host-bindings-complete · **ADRs:** [0071](../decisions/0071-the-brain-registry.md) (the brain registry), [0072](../decisions/0072-one-kit-every-binding.md) (one kit, every binding) · **Date:** 2026-10-04 · **Baseline:** [the local host process delta](threat-model-delta-local-host-process.md), whose lock and control-socket rows were brought to this task's R1 in the same change

C1 and C2 are unchanged **in policy**. This task added a second agent that can read an app's
think, made one page serve every binding, rebuilt the runner's lifecycle, pinned the page the
runner serves, and found that chat now runs the same hosted artifact runtime as a published
artifact. What follows are the new channels those two policies must survive, each control with
the code that enforces it and the test that fails if it regresses. Every sentence about
behaviour was traced to the code on `feat/TASK-20261003-host-bindings-complete`.

## What changed

1. **A brain registry with a second brain.** The local host process (Binding B) answers an app's
   think on the user's own `claude` CLI or, since this task, their own `codex` CLI
   (`apps/host-mcp/src/brains/`). A registry decides which one answers a think, or that none
   does — then the page's demo brain answers. Codex is built and **unverified**: no logged-in
   run has been observed, so it answers only when the user pins it. Ollama, Hermes and OpenClaw
   are deferred by the owner and not built.
2. **One page.** `apps/host` builds one page, `snug-host.html`, for a published artifact, a chat
   artifact, a plain file and the runner. The binding is decided at runtime in
   `apps/host/src/boot.tsx`; the second build is deleted.
3. **The runner's lifecycle (R1).** A second session attaches through the control socket, a
   take-over waits before it signals, a runner that cannot lead answers the MCP handshake with a
   refusal row, and a human CLI (`snug status | open [--print] | stop [--force]`) talks to the
   primary over the socket. The socket gained `launch-url`, the one op that answers the bearer.
4. **Page integrity (D8).** The plugin build writes the page's sha256 beside it; a process whose
   page does not match refuses and binds nothing.
5. **Chat is the hosted artifact runtime** (measured by the owner, 2026-10-03). The September chat
   runtime — `window.claude.complete`, `window.storage`, an `about:srcdoc` page — was measured
   gone, and its adapter, storage backend and binding were deleted. Chat-Claude publishes the
   skill's own `assets/snug-host.html` as an artifact, exactly as the artifact runner does.

## Assets

| Asset | Where it lives | Why this task touches it |
|---|---|---|
| The user file and its `snug_secrets` | `~/Snug/user.snug` | A brain that could run a tool could read it — unprotected, it is plaintext (R-3). |
| The user's agent logins | the Claude CLI's keychain login; Codex's login under `~/.codex` | Both brains run on them. Snug never reads either, and forwards no API-key variable to either; Codex logged in with an API key is never `ready`. (How the Claude CLI is logged in is not inspected.) |
| The loopback bearer | process memory, the page's `sessionStorage`, the launch URL's fragment | `launch-url` is a new way out of the process. |
| An app's think | the chat route's body: the app's runtime contract as the system prompt, the conversation as the prompt | Untrusted input (apps are LLM-written or shared) that can now reach a second vendor's model. |
| The pinned page bytes | `<plugin>/skills/snug/assets/snug-host.html` and its `.sha256` | The page is the whole client; the process serves only matching bytes. |

## Principals

| Principal | What it can do | What it is trusted with |
|---|---|---|
| **An app** (the sandboxed frame) | Arbitrary script in an opaque-origin frame; asks for thinks | Nothing. Its think is untrusted input (C2 holds the frame; this task is about what the think reaches). |
| **A brain** — the user's own agent CLI, a child of the runner | Whatever the agent can do on the user's machine, unless its driver removes it | To **answer** and nothing else. A brain that could run a shell, read files or browse would be a door out of the sandbox holding the user's own powers (ADR-0071 §2). |
| **The page** (the kit at `http://127.0.0.1:<port>`) | Holds the bearer; the only client of the chat route; owns the user file's database | The data plane, as before. |
| **The calling agent** (Claude Code, Cowork, the Code tab) | The four MCP tools; reads `snug_status` | Never a network or data principal (the baseline delta's tool-surface row). |
| **Any process running as this user** | Connects to the loopback port and the control socket, reads `ps`, reads and writes files | Not defended — the standard desktop trust boundary (R-40). |
| **The hosted artifact runtime** (claude.ai, published or chat-created) | Serves the page; answers thinks through `sample` | Anthropic's runtime, outside this repository. C2 inside it is measured, not enforced here. |

## Threats and controls

### The brain as a principal

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| B1 | **An app's think steers a brain into acting** — running a command, reading `~/Snug/user.snug`, searching the web | **Claude** is tool-free by construction: a frozen posture literal — `--tools '' --disallowedTools '*' --max-turns 1 --no-session-persistence --setting-sources local --strict-mcp-config`, never `--bare` — in a neutral, empty working directory (`~/Snug/host/brain/`). `apps/host-mcp/src/brains/claude.ts` (`POSTURE`, `buildStreamArgs`). The posture was walked on the real, logged-in CLI (ADR-0068 §5: `tools: []`, `num_turns: 1`), so the driver is `verified: true`. | `apps/host-mcp/src/__tests__/brain-claude.test.ts` — the argv is byte-identical to the frozen literal; the posture survives a chosen model and level |
| B2 | Same, on **Codex**, which has no single "no tools" switch | Four layers, none of which is Codex's promise. (1) The posture: every tool-shaped feature disabled by name (`CODEX_DISABLED_FEATURES`, 18 entries, each a real feature of the recorded CLI 0.160.0), `web_search="disabled"`, `--ignore-user-config --ignore-rules` (the user's MCP servers and hooks dropped), `project_doc_max_bytes=0`, `--sandbox read-only`, `--ephemeral`, a neutral empty directory `~/Snug/host/brain-codex/` created `0700`. (2) **The tripwire is an allowlist**: at `item.started`, `item.updated` or `item.completed`, only `agent_message` and `reasoning` (dropped) pass; an `error` item is a named failure; any other item type, known or not, fails the think at the first such item. (3) The child is spawned detached and its whole **process group is SIGKILLed** at once — on a tool attempt, an abort, a bound, and after every answer. (4) The answer is the LAST `agent_message`, **buffered** until `turn.completed` and written to the page only then; a stream that stops before it delivers nothing. `apps/host-mcp/src/brains/codex.ts` (`POSTURE`, `buildCodexArgs`, `spawnInOwnGroup`); `apps/host-mcp/src/brains/codex-events.ts` (`createCodexTurn`) | `apps/host-mcp/src/__tests__/brain-codex.test.ts` — the frozen posture; the allowlist trips on known and unknown items; the transcribed tool turn delivers nothing; nothing reaches the sink before `turn.completed`; a real child that ignores SIGTERM, with a grandchild, has both dead when the think's rejection settles |
| B3 | An app's instructions **break out of the TOML string** Codex parses its `-c` override as, and set `sandbox_mode` or re-enable a feature | The system prompt rides as exactly ONE `-c developer_instructions=<TOML basic string>`: the quote, the backslash and every control character escaped, a lone surrogate refused before anything is spawned. A model id must match `isModelId` (it can never read as a flag) and a level is a short lower-case word, refused again behind the route. `apps/host-mcp/src/brains/codex.ts` (`tomlBasicString`, `buildCodexArgs`); `apps/host-mcp/src/brains/brain.ts` (`isModelId`) | `apps/host-mcp/src/__tests__/brain-codex.test.ts` — quote, backslash, newline, triple quote, U+007F, a lone surrogate, and a line written to set the sandbox all stay text |
| B4 | **A credential in the child's environment** — an API key, or the parent session's messaging token and socket (a live IPC channel back into the agent) | The child environment is an **allowlist** (`HOME`, `PATH`, `SHELL`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`), built ONCE from the process's ONE whole-environment read and the same object handed to every driver; no driver can read the environment itself. `CODEX_HOME` is not forwarded either. Codex is `ready` only on the ChatGPT login line of `codex login status`; an API-key login is reported `logged-out`, and the CLI's own status line — which prints part of the key — is never repeated. `apps/host-mcp/src/brains/brain.ts` (`CHILD_ENV_ALLOWLIST`, `childEnvFor`); `apps/host-mcp/src/brains/registry.ts` (`machineDrivers`); the release gate counts whole-environment reads (`ALLOWED_WHOLE_ENV_READS = 1` in `scripts/check-host-mcp.mjs`) | `apps/host-mcp/src/__tests__/brains/registry.test.ts` — a hostile parent environment (twelve `CLAUDE_*` names, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_HOME`, `SNUG_HOME`, `NODE_OPTIONS`) reaches no child of either driver — probe, catalogue or think; `scripts/check-host-mcp.test.mjs`; `apps/host-mcp/src/__tests__/brain-codex.test.ts` (the API-key login) |
| B5 | **Cross-vendor re-route** — an app's think, carrying the user's data, sent to a second vendor because the first was logged out or outdated | `auto` is the default brain (`claude`) when it is ready AND verified, else NONE: the demo brain answers and the chip names the remedy and any ready alternative as a one-click pin. A pin names one brain; a pinned brain that is not ready is NONE, never another brain. An unverified brain answers only an explicit pin. The registry decides (`resolve`); the page mirrors the rule and never overrides it; the brain that answered rides `x-snug-brain` and the page records against THAT brain. `apps/host-mcp/src/brains/registry.ts`; `apps/host/src/local/compose-local.ts` (`brainFor`) | `apps/host-mcp/src/__tests__/brains/registry.test.ts` — the selection matrix ("claude outdated + codex ready + auto → none"; "pinned codex logged-out + claude ready → none"); `apps/host/src/__tests__/composeLocal.test.ts`; `apps/host-mcp/src/__tests__/loopback-server.test.ts` (`x-snug-brain`) |
| B6 | **An unverified posture taken for a proven one** | `CODEX_VERIFIED_VERSIONS` ships EMPTY, so Codex's `verified` is false and no version is even asked; `auto` never takes it; the chip lists it as "experimental — not yet verified on this machine". A version is added only after a journaled logged-in walk (criterion B7: a Chess move; "run `id`" and "search the web for …" producing zero non-answer items; a canary in `$CODEX_HOME/AGENTS.md` never answered). `apps/host-mcp/src/brains/codex.ts` | `apps/host-mcp/src/__tests__/brain-codex.test.ts` ("NO version has been walked"); `apps/playground/src/__tests__/brainChip.test.tsx`; the walk itself is the opt-in `SNUG_LIVE_BRAIN=codex` leg of `apps/host-mcp/src/__tests__/brain-live.test.ts`, run by the owner, never by a gate |
| B7 | **Raw agent text** reaching the page or the agent's context — request ids, endpoints, a provider's error body | **Codex:** every failure is one of our own fixed sentences (`CODEX_SENTENCES`, plus the named bound, abort, concurrency-cap and stopping sentences in `codex.ts`, which interpolate only Snug's own numbers) — never the CLI's text; `turn.failed`, `error` and stderr text is matched by pattern and never forwarded; stderr is drained and never read. `apps/host-mcp/src/brains/codex-events.ts`. **Claude: NOT sanitised — recorded as a C1 residual** (ADR-0071's 2026-10-03 amendment): the CLI's own message rides the probe's `detail` (after our remedy, in brackets, for `outdated` and `logged-out`; verbatim for `unknown`) and a failed think's error (its `is_error` result text or, when it exits before answering, the last 300 characters of its stderr), into the page's 502/503 bodies and `/status`, and — since this task — into `snug_status` in the calling agent's context (`apps/host-mcp/src/runner.ts`, `statusDoc`). See residual 1. | `apps/host-mcp/src/__tests__/brain-codex.test.ts` — the recorded logged-out run yields the sentence and none of its bytes; "every sentence is ours" |
| B8 | A user-chosen **model or level** reaching argv as a flag, or one brain's choice applied to another | The chat body carries `prefs` per brain; only the RESOLVED brain's entry is applied, and its own driver validates it (`acceptsModel`, `acceptsEffort`); every entry's shape is checked at the envelope boundary whichever brain answers. `apps/host-mcp/src/loopback-server.ts` (`parseChatBody`, `entryOf`) | `apps/host-mcp/src/__tests__/loopback-server.test.ts` ("applies ONLY the resolved brain's entry") |
| B9 | **The app's instructions on a command line** — visible in `ps`, and capped by the kernel | Both brains take the system prompt in argv (Claude `--system-prompt`; Codex `-c developer_instructions=`); the conversation goes on stdin. No credential is ever in it (C1 holds upstream: credentials never reach an LLM-bound string). The size limit is named: `argvPromptLimit()` (120,000 bytes on Linux, 900,000 on macOS) is each driver's `maxPromptBytes` on the wire, and an `E2BIG` spawn is a named "too large" sentence, never "spawn E2BIG". `apps/host-mcp/src/brains/brain.ts` | `apps/host-mcp/src/__tests__/brain-codex.test.ts` (E2BIG, including Node really throwing it); `apps/host-mcp/src/__tests__/brains/registry.test.ts` (E2BIG on Claude). Visibility is residual 5. |
| B10 | A brain probed — and the user's subscription spent — by a test, a gate or a session that never opens a page | The registry is a REQUIRED, injected dependency of the runner (never a default that probes the real machine); probes run at the first page contact, never at process start, and at most once per 30-second floor however often the page asks. `apps/host-mcp/src/runner.ts`; `apps/host-mcp/src/brains/registry.ts` (`BRAIN_PROBE_FLOOR_MS`) | `apps/host-mcp/src/__tests__/brains/registry.test.ts` ("probes are lazy"; "a re-check is at most one round per floor") |

Bounds, named in the code: Claude keeps at most four live children (`POOL_MAX_LIVE`) and two
pre-warmed keys (R-43); Codex keeps at most four live thinks (`CODEX_MAX_LIVE`), pre-warms
nothing, and names its first-output (60 s) and idle (300 s) bounds when they fire.

### The one page

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| P1 | **The page carries the local composition as live code** wherever it runs — an artifact, a chat, a file — so a page somewhere else could try to claim a bearer or talk to a runner | The runner path is tried ONLY at the literal origin `http:` + `127.0.0.1` — never `localhost` (a hosts file can point it elsewhere), `[::1]`, `0.0.0.0`, another `127.x` address, `https:` or `file:`. Only there is a `#token=` fragment claimed (and stripped from the address bar before the router reads it), and only there is `/status` asked — once, bounded at 1.5 s. A `200` becomes the runner only with the pinned wire shape AND a claimed token; a refusal counts only with the runner's constant marker header (`x-snug-runner: 1`). Anything else is not a runner, and the page boots as what the probe finds. `apps/host/src/boot.tsx` (`isRunnerOrigin`, `askRunner`, `planBoot`) | `apps/host/src/__tests__/boot.test.tsx` — every non-literal origin neither claims a fragment nor fetches `/status` |
| P2 | **A copy of the page carrying embedded blocks installs them into the real file** when served by the runner | Under `local-host` the boot reads NO embedded bundle block and NO `snug-db` block — apps arrive only as runner events. `snug-embed` refuses to write anywhere under its own skill's `assets/` (by real path, so a symlink is no way round), so the page the runner serves is never an output of a hand-in. `apps/host/src/boot.tsx`; `scripts/snug-embed.mjs` | `apps/host/src/__tests__/boot.test.tsx` ("(2) under the runner the page reads NO embedded bundle block"); `scripts/snug-embed.test.mjs` |
| P3 | **The OAuth callback document** rendering the hub (and so never completing), or doing more than delivering its code | The boot's FIRST branch: `location.pathname === '/oauth/callback'` → the callback page alone — no token claim, no `/status`, no platform, no database, no event stream. `apps/host/src/boot.tsx` | `apps/host/src/__tests__/boot.test.tsx`; `apps/host/e2e/local-oauth.spec.ts` |
| P4 | **A partial or mixed install** serving a page the build did not produce — or a damaged process taking the fixed port from a healthy one | The page is read ONCE at boot. Where a `.sha256` pin sits beside it, the bytes must hash to it; otherwise the process refuses with `page-damaged` and binds NOTHING — no lock, no control socket, no listener — so a healthy install started beside it still leads on the fixed port. A pin stops the search (no fall-through to another candidate page). No pin (a developer's tree) serves the page as it is. **What it catches: a partial copy or a stale mix of two versions. Not a same-user writer**, who can rewrite the page and its pin together (residual 6). `apps/host-mcp/src/page.ts` (`locatePage`); `apps/host-mcp/src/process.ts` | `apps/host-mcp/src/__tests__/page.test.ts`; `apps/host-mcp/src/__tests__/lifecycle-interop.test.ts`; the gate's damaged-page leg (`scripts/check-host-mcp.mjs`, tested by `scripts/check-host-mcp.test.mjs`) |

### The control socket and the lifecycle

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| L1 | **The bearer leaks through the control plane** — into an MCP message, a tool result, a log, an agent's shell transcript | `launch-url` is the ONE op whose answer carries the bearer. `open` makes the primary open the browser and answers `{ port }` only; `snug_open` answers the address without the fragment. The human CLI is `launch-url`'s only caller and asks only when its stdout is a terminal — a pipe gets the tokenless address and "run this in your own terminal", and the token never enters the CLI process at all. A token canary sweeps every other op's answer, error answers and unknown ops included. `apps/host-mcp/src/runner.ts` (`handleControl`); `apps/host-mcp/src/cli.ts` | `apps/host-mcp/src/__tests__/runner.test.ts` ("THE CANARY"); `apps/host-mcp/src/__tests__/cli.test.ts` (`--print` into a pipe never asks for the token) |
| L2 | **Any same-user process can use the socket** (mode `0600` admits exactly the user) | Not prevented — the same boundary as R-40. What such a process can do, stated: read `status` (home, file path, pid, brains with their `detail`), ask `launch-url` for the bearer (the CLI's TTY rule binds the CLI, not the socket), `call` any of the four tools in the primary (a hand-in is re-validated there by `parseAppBundle` and a bundle carrying a connection is refused — C5), `attach`, and `stop` — refused while a page is open unless the request carries a literal `force: true`. Every known op answers an ack written by the socket after the handler — `{ ok: true, op }`, or `{ ok: false, op, error }` when the handler refuses (e.g. `stop` with a page open); an unknown op answers `unknown op` and reaches no handler. `apps/host-mcp/src/control-socket.ts` (`CONTROL_OPS`, `acked`) | `apps/host-mcp/src/__tests__/control-socket.test.ts`. Residual: R-40's 2026-10-04 note. |
| L3 | **`stop` against an open page** — a page holding work the runner has not been given loses it silently | `stop` refuses with `pages-open` while any page holds the event stream, unless `force: true` (the CLI's `--force`). A stop that proceeds runs in a fixed order: reap every brain's children, emit `shutdown` to the pages, drain in-flight `/userdb` writes (bounded at 2 s), close the control socket, release the lock, close the listener; the process exits anyway at a 5 s deadline. A page that sees `shutdown`, an event stream lost for more than 4 s, or a `/userdb` write answered 401, answered with the runner's marker (the draining 503) or not answered at all says "the Snug runner stopped — reopen Snug from your agent" and sends no further writes. `apps/host-mcp/src/runner.ts` (`stop`); `apps/host-mcp/src/process.ts` (`EXIT_DEADLINE_MS`); `apps/host/src/local/client.ts` | `apps/host-mcp/src/__tests__/runner.test.ts`; `apps/host-mcp/src/__tests__/lifecycle-interop.test.ts` ("`stop` REFUSES while a page is open"); `apps/host-mcp/src/__tests__/process.test.ts`; `apps/host/src/__tests__/localClient.test.ts` |
| L4 | **A take-over kills a healthy runner** with pages open, or unlinks a live runner's socket, or a path read from a file | The recorded socket is asked FIRST; an answer carrying the lock's token hash is the owner, and the newcomer attaches with no process-table read. Identity is read only for a LIVE pid whose socket is silent, and only by the script argv token's basename against a list (`snug-mcp.mjs`, `snug-mcp.test.mjs`, `snug-local-host.mjs`) — an unreadable line is a stranger, and a stranger is refused and never signalled. One of ours is signalled only after three failed probes spread over five seconds AND a silent recorded port, then waited for (5 s); if it does not exit, the newcomer refuses with the `snug stop` remedy. Only the canonical `<host>/ctl.sock` is ever unlinked — never the path `lock.json` names. `apps/host-mcp/src/lock.ts`; `apps/host-mcp/src/identity.ts` | `apps/host-mcp/src/__tests__/lock.test.ts` ("take-over cannot kill a healthy runner"; "only the canonical ctl.sock"); `apps/host-mcp/src/__tests__/identity.test.ts` |
| L5 | **Stopping an older build** (one that does not know `stop` and answers every op with its hello) signals the wrong process | The CLI signals only when BOTH hold: the socket answers with the token hash the lock records, AND the lock's pid has our command line. The pid comes from the lock, never from the socket's answer. `apps/host-mcp/src/cli.ts` | `apps/host-mcp/src/__tests__/cli.test.ts` |

### The hosted runtime and chat

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| H1 | **C2 inside a chat artifact** — the app frame escaping into the chat page | **Measured, not enforced here.** The owner's probe (2026-10-03, claude.ai in Chrome): the page ran at a real `frame.claudeusercontent.com` origin with `window.claude = { use, hot }`; the nested `sandbox="allow-scripts"` frame was at origin `null`, its `fetch` raised `securitypolicyviolation` (one from its own `connect-src 'none'`), and reaching `parent.document` threw. The frame Snug creates is the same `SnugAppFrame` everywhere (C2's §5 rows). | The probe is a maintained diagnostic, `scripts/runtime-probe.html` (`scripts/runtime-probe.node-test.mjs` tests the probe, not the runtime). No suite reproduces claude.ai; re-measuring is a person's act. |
| H2 | **A credential inside an artifact or chat page** | There is none to leak: the hosted composition turns `connections` off (`hostCapabilities()`), and the availability derivation disables every app that needs a connection, on the shelf and on its route. `apps/playground/src/platform/hostCapabilities.ts`; `apps/playground/src/platform/availability.ts` | `apps/playground/src/__tests__/availability.test.ts`; `apps/host/src/__tests__/availabilityOffers.test.ts` |
| H3 | **The save publishing something other than the kit page** — the platform's wrapper, a fragment, a page wrapped twice | The kit reads its own source (`fetch(location.href)`) and lifts it out of a wrapper only when the wrapper is the measured contract-0.2.67 skeleton byte for byte (536 bytes through `<body>`: charset, viewport, a reset — nothing else; matched against two real read-backs) or the September viewer's measured shape. A fragment, a skeleton around nothing, a skeleton inside a skeleton, a foreign head or trailing content is refused by name, and the save then publishes nothing ("export to keep a copy"). The save publishes the BARE kit page. This is a shape check, not an integrity control. `scripts/lib/page-blocks.mjs` (`unwrapViewerPage`, `verifyKitPage`); `apps/host/src/storage/artifactHtml.ts` | `scripts/lib/page-blocks.test.mjs`; `apps/host/src/__tests__/artifactHtml.test.ts`. Fail-closed cost: residual 4. |
| H4 | **A page meeting the old chat runtime** calls an adapter nobody maintains | The September runtime's code is deleted. A page that meets only `window.claude.complete` is decided like any page with no host brain — the demo brain answers, nothing is asked and nothing is touched. `apps/host/src/probe.ts` | `apps/host/src/__tests__/probe.test.ts`; `apps/host/src/__tests__/oneKit.test.ts` (lints the removed identifiers out of both apps) |

### Gate and walk isolation

| # | Threat | Control — enforced by | Proven by |
|---|---|---|---|
| G1 | **A gate reaching the user's real `~/Snug`** or a real CLI, or talking to the user's running runner | The gate's launch legs start the shipped launcher with `HOME=<mkdtemp>`, `SNUG_HOME=<mkdtemp>/Snug`, `PATH=<this Node's directory>` and nothing else, cwd `/`; the FIRST assertion is that `snug_status` names a home and file under that temp directory and the pid the leg spawned — anything else aborts the leg before a second process starts. A no-home leg proves `home-unresolved`. Every process is reaped in a `finally`. No leg spawns a CLI: a probe runs only at the first authenticated page contact, and no leg makes one (the page is read from the open document route, which carries no bearer) — so even a `claude` installed in the Node directory on the leg's PATH is never started. The release bundle carries no `SNUG_MCP_TEST_` string. `scripts/check-host-mcp.mjs` (`runLaunchLegs`, `isolationEnv`, `FORBIDDEN_PREFIX_IN_RELEASE`) | `scripts/check-host-mcp.test.mjs` |
| G2 | **A walk spending the subscription or touching real state** | `scripts/walk-desktop-host.mjs` is opt-in and in no gate (its own tests never start it). It is handed the real HOME (the CLI's login lives there) but refuses a `SNUG_HOME` that is, or is inside, `<home>/Snug`; it believes nothing until the status names its own temp home and its own child's pid (`whyNotMine`); it never asks the socket to stop or open, signals only its own child, and passes every report line through `scrubBearer`. The live-brain tests run only under `SNUG_LIVE_BRAIN=1` or `=codex`. | `scripts/walk-desktop-host.test.mjs`; `apps/host-mcp/src/__tests__/brain-live.test.ts` (skipped unless opted in) |

## Accepted residuals

Numbered here; the consolidated model carries them as R-44 to R-48, with R-40 and R-11 amended.

1. **Claude's own words pass through (C1 residual, R-44).** The `claude` driver forwards the
   CLI's text — a probe's `detail` and a failed think's message — to the page and into
   `snug_status`, so into the calling agent's context. Nothing scrubs it. Kept deliberately:
   the CLI's words carry the remedy (`Please run /login`, `run 'claude update'`), and it is the
   user's own CLI speaking to the user's own agent and page. What is not bounded is whatever
   the CLI itself chooses to print in an error; no Snug credential is in its environment or argv.
2. **Codex is unverified until a logged-in walk (R-45).** Not measured: a successful turn
   (the success fixture is TRANSCRIBED from upstream's `exec_events.rs`, not recorded), whether
   each disabled feature really removes its tool, whether `developer_instructions` is honoured
   as the system slot, and the cold-start time. Bounded by: pin-only, never `auto`, labelled
   experimental; the walk is printed for the owner (B7) and journaled when run.
3. **The tripwire withholds the answer, not the act (R-46).** It fires on the first non-answer
   item, but it can only react to a line Codex has already written: between a tool item's
   first line and the group SIGKILL, the tool may have run and its output may have gone back to
   Codex's model in the CLI's own next request. Nothing of it reaches the app or the page. Bounded by the
   disabled features (the tool should not exist), Codex's read-only sandbox (which, per
   ADR-0071, still lets a model read files and run commands) and the kill. Two edges of the
   same residual: the tripwire reads only `item.*` events — an unknown top-level event type is
   ignored by design, so a tool a future CLI reported some other way would not trip it; and a
   Codex think in flight when the runner itself is SIGKILLed is not reaped by the runner (the
   child leads its own process group and its stdin is already closed). A clean stop reaps it.
4. **The skeleton reader is a byte match (R-47).** If the hosted runtime changes one byte of
   its skeleton, every save from a published or chat-created kit refuses with "export to keep a
   copy" until the constant is re-measured. It fails closed — availability, never integrity —
   and the export path is untouched.
5. **App instructions ride `ps`-visible argv on both brains (R-48).** Claude's system prompt
   (R-43) and now Codex's developer instruction are command-line arguments, visible to any
   process that can list them. No credential is in either. Codex's size cap counts the prompt
   before TOML escaping, so a quote-heavy prompt near the cap fails with the named "too large"
   sentence rather than earlier — it fails safe.
6. **The page pin and the control socket stop no same-user process (R-40's note).** The pin
   catches a partial copy, not a writer who rewrites the page and its pin together; the socket
   answers `launch-url`, `stop` with `force: true`, and `call` to any process running as the
   user.
7. **The gate's launch legs use the fixed port when it is free.** While a leg runs, a real
   runner started at that moment lands on an ephemeral port with its OAuth rows disabled —
   availability only, the baseline delta's residual 4.

**Withdrawn, so not threats of this system:** the chat brain's learned prompt cap, the
"measure" act, and the npm scope with SRI as its only control (ADR-0072 §5 and §6) were never
built — R5 withdrew them on the measured runtime.

## What this delta does NOT claim

- It does not claim Codex is tool-free. It claims the four layers above exist and are tested
  against recorded and transcribed streams; the claim about the real CLI waits for the walk.
- It does not claim C2 inside claude.ai is enforced by this repository. It was measured once,
  by a person, on 2026-10-03.
- It does not claim anything about Ollama, Hermes or OpenClaw: none is built, and ADR-0071 §2
  records the rule each must meet.
- It does not claim the walks have run. The desktop-host walk, the Cowork walk, the Codex
  walk and the hosted chat walk are printed for the owner and recorded "ready for walk".
