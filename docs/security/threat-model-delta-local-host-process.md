# Threat-model delta — the local host process (Binding B)

**Task:** TASK-20260907-binding-b-plugin-host · **ADR:** [0068](../decisions/0068-local-host-process.md) · **Date:** 2026-09-07

Binding B adds a Node process the agent's host spawns over stdio. It serves the kit on
loopback, fills the three platform seams Snug Desktop fills natively (`fetchImpl`, the
OAuth callback route, `userdbBackend`), and exposes a four-tool control plane. C1 and C2 are
unchanged **in policy**: the page's connected-fetch executor remains the only seat that
reads a credential and calls fetch. What follows are the new *channels* those policies must
survive.

## What is new

| Surface | The threat | What holds |
|---|---|---|
| **Loopback HTTP data plane** (`127.0.0.1:43127`, fixed) | Any page in any browser on this machine can address it; a DNS rebind makes an attacker's page same-origin to it | A 256-bit per-launch bearer on every data-plane call, plus `Host` equal to the served `127.0.0.1:<port>`. **Measured 2026-09-07** with headless Chromium under `--host-resolver-rules=MAP evil.test 127.0.0.1`: after a rebind the attacker's GET carries **no `Origin` and no `Sec-Fetch-Site`**, and `Host` is the only header naming it — so `Host` is the wall, not a belt. `Origin` is checked where sent; `Sec-Fetch-Site` must be the literal `same-origin`, never `same-site` (a different loopback PORT reads as same-site, so accepting it would admit every other local service). No CORS headers are sent at all. |
| **Preflight as a structural guard** | A route reachable by a *simple* request lets a foreign page cause a side effect it cannot read | Every data-plane route requires the bearer header, which forces a CORS preflight; the preflight is answered without CORS headers, so the real request never follows. This is load-bearing: moving auth to a cookie or query parameter would silently remove it. |
| **`/oauth/callback`, unauthenticated by necessity** | An open route on the data plane's own origin, reachable by any local page | It serves the kit DOCUMENT and nothing else — the same bytes as `/`, no state read, no state written, no query parameter interpreted server-side. It must be open because a provider's redirect carries only what the *provider* put in the query, so there is no bearer to present and gating it would 401 every real callback. The code in that URL is delivered to the wizard by the page over `BroadcastChannel` (same-origin) and exchanged for a token through `/fetch`, which IS bearer-gated: reaching this route buys an attacker the page's public HTML, which they could fetch from `/` anyway. |
| **The bearer's custody** | A token on disk is a token a second local process can read | Memory in the primary, `sessionStorage` in the page, and the launch URL's **fragment** — which a browser never sends to a server. It is in no lock file, no log, no MCP message and no tool result: `snug_open` makes the *process* open the browser, and the CLI fallback (`snug open --print`) prints the URL only when its stdout is a terminal — a pipe gets the address without its fragment, and the CLI does not ask for the token. The lock keeps only its SHA-256. |
| **The control socket** (`~/Snug/host/ctl.sock`, `0600`) | An attached session or the human CLI would otherwise need the bearer; a client reading an older build's success-shaped answer as "done" | A unix socket, so there is no port to squat and no network path: the filesystem decides who connects (the WhatsApp helper's posture). It answers seven control operations and nothing else — `hello`, `status`, `open`, `launch-url`, `call`, `attach`, `stop`; data-plane paths are not routed on it, and lines are capped. Every known op answers an ack written by the socket after the handler — `{ ok: true, op }`, or `{ ok: false, op, error }` when the handler refuses (e.g. `stop` with a page open), an unknown op answers `unknown op` and reaches no handler, and an older build's hello carries no ack, so it is never read as success. **It carries the bearer on exactly one op**, `launch-url`, whose only caller is the human CLI (see the bearer row); `open` makes the primary open the browser and answers the port alone, and a token canary sweeps every other op's answer. `call` runs one of the four tools in the primary's own code, so an attached session's hand-in is re-validated there. `stop` refuses while a page holds the event stream unless the request carries a literal `force: true`. `attach` marks a connection as a session, counted until it closes; nothing else counts as presence. |
| **The lock and take-over** | Two processes writing one user file; a recycled pid; a live primary's socket unlinked from under it; a healthy runner killed by a newcomer that judged it wedged | The lock is written to a temp file and **linked** into place — exclusive like `O_EXCL`, and never visible empty — **before** any bind (two ephemeral binds never collide, so bind-then-write would let both "win"). A newcomer asks the recorded **socket first**: an answer carrying the token hash the lock records is the owner, and it attaches without reading the process table. A silent socket and a dead pid is taken over. A silent socket and a **live** pid is the one place identity is read (`/bin/ps -ww -o command= -p <pid>` by absolute path; `/proc/<pid>/cmdline` on Linux): the basename of the script Node was given must be one of `snug-mcp.mjs`, `snug-mcp.test.mjs`, `snug-local-host.mjs` — never a substring of the line — and an unreadable line is a stranger. A stranger is refused and never signalled — killing a stranger is worse than the conflict it repairs. One of ours is signalled only after **three failed probes spread over five seconds** and only if its recorded port is silent too, then **waited for** (5 s); if it does not exit, the newcomer refuses with the `snug stop` remedy rather than become a second writer. Replacing a record is one step under a take-over mutex. Only the canonical `<host>/ctl.sock` is ever unlinked — never the path `lock.json` names — and not while another runner answers on it. |
| **Read-only custody** | Snug Desktop holding the same file | The page **refuses to open** and names the holder. It does not open read-only: both of `packages/db`'s save paths swallow a failed write with a bare `catch` and no persist-error seam exists, so a read-only page would take an hour of work and lose it silently on tab close. Writes are additionally refused with `423`. |
| **The store's default target** | A test, a script or a stray import reaching the user's real `~/Snug` by doing nothing | There is no default. `resolveHome()` requires either `SNUG_HOME` or an explicit `allowRealHome`, which exactly one caller passes — the shipped entry a host spawns; the test-hooks build passes neither and can never reach a real home. Enforced in the type AND at runtime, because the failure it prevents is silent. **This is a repair:** on 2026-09-07 a `/userdb` test wrote 2 MiB of zeros over the owner's live user file, and two weeks of data were lost. |
| **The `claude -p` child** | A spawned CLI inheriting the parent session's credentials | The child's environment is built from an **allowlist** (`HOME`, `PATH`, and terminal basics), not a denylist. **Measured 2026-09-07**: a Claude Code session exports twelve `CLAUDE_*` variables including `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_MESSAGING_SOCKET` — together a live IPC channel back into the running session. A denylist against an undocumented, version-varying namespace drifts on the next CLI release; an allowlist cannot. |
| **The agent is not a network principal** | An MCP tool that fetches, proxies, reads a credential or runs SQL would make the LLM one | The tool surface is exactly `snug_status`, `snug_open`, `snug_hand_in`, `snug_list_apps`, frozen by an allowlist test that fails on any addition, with a second test refusing any tool *name* that reads as a data-plane capability. This is C1's "credentials never reach the LLM" applied to the agent that spawned us. |
| **The proxy as a second reader of the executor's output** | It necessarily handles injected credential values to forward them | **Transit-only, not "value-blind"** — that term is taken: the repo defines it as `packages/runner` never importing the credential layer at all, proven by a source lint. The honest formula is the desktop's: values are handled in transit and never logged, persisted, echoed or retained, with every error message passing `scrubAuthValues` against the values it saw. Pinned by a canary test across logs, headers, bodies and error text. |

## Accepted residuals

1. **Any process running as this user can open the loopback socket.** The bearer is the only
   guard there; `Host` and `Origin` bind browsers, not `curl`. This is the standard desktop
   trust boundary — the same one protecting every other credential Snug holds — and no
   app-layer guard improves it.
2. **No capability belt.** Snug Desktop's outbound fetch sits behind a Tauri capability
   scope baked in at build time, a ceiling no runtime bug can widen. This process has
   `node:https` and the proxy's own gates, and nothing beneath them. The gates are therefore
   the whole story here, where on the desktop they are the inner of two layers.
3. **Inbound DNS rebinding is defended by `Host`, not by resolution.** The `Host` check
   refuses a rebound page. Nothing here inspects resolved addresses on the *outbound* side:
   the executor's own SSRF gate is literal-only, and adding resolution would be a new policy
   the desktop does not have. Note this is a **different** exposure from the desktop's
   outbound rebinding residual and carries its own row rather than inheriting that one.
4. **Port 43127 squatting.** A local process may hold it first. The runner falls back to an
   ephemeral port and disables the OAuth rows with a named reason rather than silently
   changing an origin the user registered with a provider. Availability only.
5. **The `claude -p` argv is visible in `ps`.** The system prompt rides as an argument, as
   the desktop's authorize URL does. No credential is in it.
6. **The launch URL's fragment persists** in browser history and is readable by an extension
   with tab access, and the CLI fallback prints it into terminal scrollback. Both are the
   price of handing a token to a browser without writing it to disk.

## What this delta does NOT claim

- It does not claim the page-side 1 MiB cap tears down a connection. It cannot: a
  reconstructed `Response` has already fully materialised. The cap that matters runs in the
  process, while reading, and both sides trip at the same protocol constant.
- It does not claim the LAN rungs are covered. The page carries neither `lanFetch` nor
  `lanHttpPrivate`, so a LAN row gets the executor's own named refusal.
- It does not claim anything about Windows. This process is macOS-only, as the desktop is.

## Amendment — 2026-09-13 (TASK-20260913-binding-b-marketplace-plugin, ADR-0069)

| Surface | The threat | What holds |
|---|---|---|
| **The pre-warmed child** (`brain-child.ts`) | Up to two idle `claude` processes per user, each ~257 MB, holding a system prompt in argv; a request answered from the WRONG child; a child outliving the runner | A child holds nothing but its system prompt until its ONE request arrives, answers it, and is reaped — no transcript is ever reused, so a child can hold nothing another caller did not send. The pool is keyed by `sha256(JSON [system prompt, model, effort])` (ADR-0070) — a child pre-warmed for one model is never handed to a request for another — and a busy child is never shared. **The user's model and effort reach the child's argv** (ADR-0070): the chat route refuses at the envelope boundary any model id that is not a string, starts with anything but a letter or digit, or carries whitespace/control characters (so a value can never read as a flag, whatever the CLI's parser does), and `buildStreamArgs` refuses the same again behind it; effort is one of five literals; both ride BEFORE the posture, which stays last and unchanged. Only a bearer-holding caller (the page) can send either. Bounds are named constants: two pre-warmed keys (LRU), a five-minute idle TTL, a reap on `stop()`, on abort (the page closing its request), on error, on exit; the children's stdin is a pipe from the runner, so the runner's death (even SIGKILL) ends them on EOF. **Measured 2026-09-13:** a child idle five seconds answers its first message in 1.7 s against ~5 s cold. The argv is `ps`-visible as before (residual 5), now for up to two idle children. |
| **The streaming chat route** | A delta forging an SSE frame boundary; a partial answer read as a complete one | Every frame is one `JSON.stringify` of the whole payload — a delta's text is a string VALUE, so `\n\ndata:` inside it stays inside its frame (pinned by a test with exactly that text). A failure before any delta is a 502 the page reads; after a delta the stream ends with **no finish**, which the page's adapter reports as a dropped stream, never a complete answer. |
| **The launcher's PATH walk and the binary resolution** (`scripts/snug`, `brain-resolve.ts`) | Executing a `node` or `claude` an attacker placed first in a search directory | The same trust as the user's shell (residual 1: any same-user process): PATH first, then the installers' directories under the user's own home and the two system prefixes, from ONE list. Nothing is downloaded; with no Node the launcher prints one line and exits 1. The manifest's `args` array is passed by the hosts as literal argv, never through a shell, so a plugin root with a space is one argument; `/bin/sh` is named by absolute path. HOME and PATH are read by NAME (the release gate's whole-env count stays at three). |
| **The plugin tree as a distribution** | A marketplace clone whose generated files a reviewer cannot tie to a source | `PROVENANCE.json` names the monorepo commit and the sha256 of every shipped file; the gate rebuilds the tree from sources and refuses a SKILL.md, reference, launcher, README or provenance that drifted; the distribution repo is a verbatim copy of that tree. The plugin ships no hooks and no data-plane tool (both gated). |

**Residuals added:** (7) two idle `claude` processes per user for up to five minutes after a
think — memory, and a `ps`-visible system prompt, accepted for the ~3 s saved on every think
after the first; (8) the system prompt on argv would hit Linux's 128 KiB per-argument limit
for a very large app — moot on macOS, noted for the Codex phase (`--system-prompt-file` is the
remedy); (9) the page advertises an 8,192-token output cap the CLI does not enforce.

### Amendment — 2026-09-13, second pass (the security and correctness reviews of TASK-20260913)

| Surface | The threat | What holds |
|---|---|---|
| **The child's working directory and settings** | A plugin process inherits the AGENT HOST's cwd — the user's current project — so a child would discover that project's `CLAUDE.md`, run its hooks around an app-authored prompt and spawn its MCP servers; and the user's own `~/.claude/CLAUDE.md` memory rode into every think | **Measured 2026-09-13:** a marker `CLAUDE.md` in the cwd reached the model ("PINEAPPLE"); the owner's memory file reached it too ("Yes"), 1,319 input tokens for a one-word answer. Every child now runs in a neutral, empty directory under the Snug home (`~/Snug/host/brain/`) with `--setting-sources local --strict-mcp-config`: no project, no user CLAUDE.md, no hooks, no MCP servers (446 tokens, "No"), and the keychain login intact. `--bare` was measured too and is NOT an option: it skips keychain reads ("Not logged in"), which is why D5 forbids it. The user's login is what "the user's own CLI" means here; the settings are not. Q8 for the owner: `local` (built) or `user` (the user's own hooks and memory in every think). |
| **The child's PATH under a desktop host** | Empty; an npm-installed `claude` is a `#!/usr/bin/env node` shim that exits 127 with no `node` on PATH — the probe would say `unknown` | The child's PATH starts with the directory of the Node running the host — the one the launcher found — so the shim finds it. Named reads only; the allowlist is unchanged. |
| **In-flight children** | An app looping its thinks fans out a `claude` process (~257 MB) and an API call on the user's subscription per loop | A named cap (`POOL_MAX_LIVE` = 4) counts what is answering, warm or fresh; beyond it a request is refused by name (the page reads a 502 with the sentence), never queued. |
| **A failed spawn; the last line; a split character** | A child whose spawn failed emits `error` and never `exit` — it would read as alive and be handed out; `exit` can fire while the last stdout read is in flight, losing the one result line that names the remedy; a pipe read ends on a byte boundary, turning a split em dash into U+FFFD ×3 inside valid JSON | `error` marks the child dead; the request fails on `close` (stdio drained), never on `exit`; stdout and stderr go through a stateful UTF-8 decoder; a line past 16 MiB reaps the child. Each has its mutant test. |
| **Provenance** | A commit that cannot reproduce the hashes (a dirty tree); the root marketplace manifest outside the hashes | `PROVENANCE.json` sits at the MARKETPLACE root and covers every shipped file including `.claude-plugin/marketplace.json`; its commit is suffixed `-dirty` when the tree differs from HEAD — the owner's push refuses that (next-steps); the gate accepts it (a developer's tree is dirty by definition). The Agent Skills validator the gate runs is pinned (`skills-ref==0.1.1`). |

**Residual added:** (10) the user's own hooks and memory are OUT of app thinks by default (`local`) — a user who wants their CLAUDE.md in every app's context has no switch; Q8.

## Amendment — 2026-10-04 (TASK-20261003-host-bindings-complete, R1)

The **control socket** and **lock and take-over** rows above, and the CLI sentence of the
**bearer's custody** row, were rewritten in place to describe R1's code (`lock.ts`,
`control-socket.ts`, `identity.ts`, `refusals.ts`, `cli.ts`, `runner.ts` under
`apps/host-mcp/src/`). The wording they replace described the runner before R1 and is in git
history. What was untrue of it, found 2026-10-03:

- the shipped build wired `commandLineOf: () => undefined`, so every live holder read as a
  stranger and a second window was always refused; the identity rule was a substring
  (`/snug-mcp/`), which `tail -f snug-mcp.log` satisfies;
- the socket's `open` answered the launch address WITH its token to any caller, and the CLI
  printed it wherever stdout pointed — the row's "it carries no bearer" was false;
- take-over read the command line first, signalled after ONE silent probe, did not wait for
  the exit, and unlinked the socket path the lock record named.

A runner that can neither lead nor attach now answers the MCP handshake and names its cause
from one refusal table (`home-unresolved`, `home-unwritable`, `lock-held-by-stranger`,
`lock-contended`, `older-build`, `socket-path-too-long`, `socket-in-use`, `listen-failed`,
`page-damaged`), each with a remedy; `lock-held-by-stranger` claims only that the process
could not be identified, and its remedy quits the session before the lock file is deleted.

**Residual added:** (11) the control socket is residual 1's boundary with no bearer in front of
it: any process running as this user can ask `launch-url` for the bearer, `stop` with
`force: true` while pages are open, and `call` any of the four tools. The brains, the one page
and the page pin are in [the brains-and-chat delta](threat-model-delta-brains-and-chat.md).
