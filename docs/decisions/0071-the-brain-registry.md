# 0071 — The brain registry: any agent the user already has may answer, and none of them may act

- **Status:** accepted (owner-delegated, 2026-10-03: the task's ask was "make your own decisions"; Q2 and Q3 of the task file are the defaults taken here, each reversible by one word). **Scope set by the owner the same day: the registry, the rule and the `codex` driver ship now; the `ollama`, `hermes` and `openclaw` drivers and the Hermes walk (S5) are deferred** ("skip … for now") — what was learned about them is recorded here so it is not re-derived. **Built 2026-10-04** on `feat/TASK-20261003-host-bindings-complete`: the registry, the `claude` driver and the `codex` driver, with Codex UNVERIFIED (pin-only, never `auto`) until the owner's logged-in walk is journaled — see "What shipped" at the end.
- **Date:** 2026-10-03
- **Task:** TASK-20261003-host-bindings-complete
- **Amends:** ADR-0069 §1 and §5 (the brain axis gains a contract and its second member) · ADR-0070 (the model/effort choice becomes per brain) · ADR-0065 §4 / D15 (narrowly: a pin among brains the machine already has) · ADR-0068 §5 (the shim is one driver of several)

## Context

ADR-0069 named two axes — where the body runs (the binding) and what answers the thinks (the brain) — and built one brain for Binding B: the user's own `claude` CLI as a tool-less child. Its remainder was "`codex exec` / Hermes / OpenClaw / Ollama". The code had no seam for a second one: `claude` is hard-wired into the binary lookup, the argv, the child class, the probe, the catalogue and the page's labels; the only provider-neutral thing is the three-method `Brain` interface the chat route calls.

**Codex, measured 2026-10-03 on the real CLI 0.160.0** (run from a scratch directory with its own `CODEX_HOME`, logged out; nothing was installed into the owner's machine):

- `codex exec` accepts, without complaint, every flag this decision relies on: `--json --ephemeral --skip-git-repo-check --sandbox read-only --ignore-user-config --ignore-rules -C <dir> -m <model>`, `--disable <feature>` for each tool feature, and `-c` overrides for `web_search`, `project_doc_max_bytes`, `developer_instructions`, `model_reasoning_effort`. The prompt is read from stdin when the argument is `-`.
- There is **no single "no tools" switch** (the request is open upstream). `codex features list` names 150 features; the tool-shaped stable ones that default on are `shell_tool`, `unified_exec`, `unified_exec_tty`, `view_image`, `apps`, `plugins`, `multi_agent`, `image_generation`, `browser_use` (+ `_external`, `_full_cdp_access`), `computer_use`, `hooks`, `sleep_tool`, `skill_search`, `tool_suggest`, `goals`. Only `shell_tool` has been observed (third-party) to remove its tool when disabled. The read-only sandbox still lets the model read files and run commands.
- `exec --json` is JSONL: `thread.started`, `turn.started`, `item.started|updated|completed` (item types `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`), `turn.completed {usage}`, `turn.failed {error:{message}}`, `error {message}`. The answer arrives whole as one `item.completed`/`agent_message` — never as token deltas.
- `codex login status` exits 1 and prints `Not logged in` instantly and offline; logged in it names the method (`Logged in using ChatGPT` is the subscription). A logged-out `exec` instead retries for ~15 s before `turn.failed` with `unexpected status 401 Unauthorized` and exit 1 — so readiness is asked of `login status`, never of a think.
- `codex debug models --bundled` prints the model catalogue offline and logged out (`slug`, `display_name`, `visibility`, `default_reasoning_level`, `supported_reasoning_levels[].effort`): the model list and each model's own effort levels, exact.
- The npm `codex` is a `#!/usr/bin/env node` shim: under an empty PATH it exits 127 — the same finding as `claude` (ADR-0069 §6), with the same cure (the launcher's Node directory on the child's PATH).
- NOT measured (needs the owner's ChatGPT login): a successful turn, whether each disabled feature really removes its tool, and whether `developer_instructions` is honoured as the system slot.

**The other three, from their own documentation (not run — deferred):** Hermes (`hermes gateway`, `:8642`) and OpenClaw (`:18789`) answer an OpenAI-shaped request by running **a full agent turn with the agent's own tools** ("including terminal commands"; "treat the endpoint as full operator access"), and neither documents a zero-tool mode; Ollama's OpenAI-compatible route cannot set the context window (default as low as 4k tokens) and truncates an over-long prompt silently.

That is the decision's centre. An app's think is **untrusted input**: apps are LLM-written, may arrive by a shared link, and run in a sandbox precisely because nobody vouches for them (C2). If the brain that reads that input can run a shell, read files or browse, the sandbox has a door — a confused deputy holding the user's own agent's powers. ADR-0068 forbade a data-plane tool for the *agent* for this reason; D5's `--tools ''` is the same rule seen from the brain's side. A second brain must not quietly repeal it.

## Decision

1. **One contract.** A brain is a `BrainDriver`: `id`, `name`, `via` (whose it is, in words), `probe()` → readiness, `catalog()` → models and thinking levels in the brain's OWN vocabulary, `create()` → the existing `Brain { stream, complete, stop }`, and its own validators for a model and a level. The registry is an injected dependency of the runner (never a default that probes the real machine), probes lazily on the first page contact, resolves which driver answers a think, and reports all of them on `/status`. `claude` is its first driver and is behaviour-identical: the frozen argv, the pool key, the env allowlist and every existing test pass unchanged. A third brain is a file and a registry line.

2. **No brain may act.** Every driver answers **tool-free by construction**, and the construction is ours, not the agent's promise. A driver's posture is a frozen literal in a test. There is no "allow tools" switch.
   - `claude` — `--tools '' --disallowedTools '*' --max-turns 1` (ADR-0068 §5, unchanged).
   - `codex` — every tool-shaped feature disabled, web search disabled, user config and rules ignored (which drops the user's MCP servers and hooks), project docs off, the read-only sandbox, a neutral empty working directory under the Snug home, an ephemeral session; **and a tripwire that is an allowlist**: only answer-shaped items (`agent_message`, and `reasoning`, which is dropped) pass; an `error` item is a named failure; ANY other or unknown item type kills the child — spawned detached, its whole process group SIGKILLed at once — and fails the think by name. The answer is buffered and delivered only after `turn.completed` on a stream that held nothing else. **What this does and does not bound:** the tripwire withholds the ANSWER, so no tool result reaches an app; it does not undo a read or a call a tool already made — for shell commands that is bounded by the read-only, network-less sandbox, and for anything else by the disabled features. So Codex is `verified: false` until a logged-in walk has shown adversarial thinks producing zero non-answer items: listed, selectable only by an explicit pin and labelled experimental, never taken by `auto`.
   - *(deferred)* `ollama` — a bare model; the driver never sends `tools`. `hermes`, `openclaw` — only when the agent profile the gateway would answer with provably has no tools; otherwise listed with the one change that makes it safe, and not selectable. Passing a request through to a gateway as it is — the original T3 wording — is rejected for good.

3. **Credentials stay out.** No driver passes the parent environment to a child (the allowlist), and no API-key variable is ever forwarded (`OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` beside the `ANTHROPIC_*`/`CLAUDE_*` set): a brain on a key is not "the user's own agent" (D15). Codex is `ready` only when it reports the ChatGPT login.

4. **Selection is `auto`, with a pin — and it never changes vendor without a user act.** `auto` is the default brain (`claude`) when it is ready, else NONE: the demo brain answers and the chip shows the remedy and any other ready brain as a one-click pin. A pin names one brain; a pinned brain that is not ready is the demo brain, never another brain. (An app's think carries the user's data; sending it to a different provider because the first one was logged out is the silent re-route the multi-provider threat model already forbids — plan review, 2026-10-03.) The pin is per machine, beside the model and effort (ADR-0070 §5), never in the user file. A host hint (`--host`) is NOT built: nothing needs it until a second host spawns the runner (T9). This amends D15 narrowly, as ADR-0067 and ADR-0070 did: the kit still never *asks* — no key, no URL, no account, no mode — and a brain that is not ready cannot be picked.

5. **The model and the thinking level are per brain, in that brain's words.** Claude's `--effort` over its catalogue; Codex's `model_reasoning_effort` over the levels its own catalogue lists for the chosen model. Nothing maps one vocabulary onto another (ADR-0070 §3's rule). What ANSWERED is shown, never what was asked (ADR-0059 rule 2).

6. **Readiness keeps its five states** — `ready | logged-out | outdated | absent | unknown` — each with one sentence a person can act on, asked the cheapest honest way per driver (`claude`: the brain's own wire, as today; `codex`: `login status`, then the catalogue). What a driver sends the page when a think fails is one of a fixed set of sentences; an agent's raw error text or stderr is never forwarded.

7. **The system prompt never rides Codex's argv twice.** The app's runtime contract is the developer instruction (`-c developer_instructions=<TOML string>`), the conversation is the prompt on stdin; nothing is written to the working directory.

### Amendment — 2026-10-03 (R4's independent verification)

- **§6's fixed-sentence rule is Codex's, not every driver's.** The `claude` driver keeps ADR-0070's standing behaviour: the CLI's own message rides the probe's `detail` ("… (API Error: 400 …)") and a failed think's error, because the CLI's words carry the remedy (`Please run /login`, `run 'claude update'`) and were kept deliberately in ADR-0069 §6. Since this range that `detail` also rides `snug_status` into the calling agent's context. Recorded as a C1 residual for the threat-model delta rather than sanitised: Claude's output is the user's own CLI talking to the user's own agent, and a fixed sentence would say less than the CLI does. Codex's text is sanitised because its tool-free posture is unverified (§2).
- **Codex is unverified until walked (B6/B7).** `CODEX_VERIFIED_VERSIONS` is empty; the opt-in live leg (`SNUG_LIVE_BRAIN=codex`) and the printed walk exist; `verified: true` requires a journaled run on a logged-in CLI showing adversarial thinks with zero non-answer items and a planted canary never answered.

## Alternatives considered

- **Trust Codex's feature flags alone.** Rejected: only one of them has been observed to remove its tool. The tripwire makes the invariant ours.
- **A disclosed "this brain can act" mode.** Rejected: a disclosure does not bound a confused deputy, and the user who reads it is not the one who wrote the app.
- **The Codex app server (warm, streaming).** Deferred: marked experimental upstream; `exec` is the documented single-shot. Its cost is whole-message delivery and a cold start per think.
- **Replace Codex's built-in instructions (`model_instructions_file`).** Rejected for now: unmeasured against a ChatGPT login, and a brain that refuses every think is worse than one whose persona is slightly coloured.
- **No pin; `auto` only.** Rejected: a user with two agents has a real preference, and an unverified brain needs a deliberate act.
- **`auto` falls through to the next ready brain.** Rejected by the plan review: it moves an app's context across vendors with no user act.
- **Build all four now from documentation.** Reversed by the owner mid-session: three drivers nobody can run here would be three unverified claims.

## Consequences

- Positive: a Cowork user with no Claude CLI but with Codex has a brain; one vocabulary for readiness; the next brain is a file, not a rewrite; the sandbox boundary does not depend on which agent the user owns.
- Negative / residuals: Codex answers arrive whole, not streamed, and every think is a cold process; its posture and its system slot are verified against a logged-in CLI only by the opt-in live test until the owner walks it; the developer instruction rides argv (`ps`-visible, as Claude's system prompt is — R-43's residual, restated); Ollama, Hermes and OpenClaw users still have no brain of their own.
- Docs owed (this task): the threat-model delta (the brain as a principal; the tripwire), architecture, code-map, glossary ("brain driver", "host hint"), the program record's T3 row (Codex done; three deferred), ADR-0069/0070 status lines, a next-steps entry carrying the three deferred drivers with this ADR's rule.

## Amendment (2026-10-04, TASK-20261003-host-bindings-complete) — what shipped

- **The contract and the registry.** `apps/host-mcp/src/brains/brain.ts` (`BrainDriver`, the
  child-env allowlist, the argv limit), `registry.ts` (injected into the runner by both entries;
  lazy — the first page contact, then on request, at most once per `BRAIN_PROBE_FLOOR_MS` =
  30 s; `stop()` reaps every brain it made). `machineDrivers` is the one place the real machine is
  read, with one whole-environment read, which `check-host-mcp` counts.
- **Selection, as §4 says and no wider.** `auto` resolves to `claude` only, and only when it is
  ready and verified; otherwise no brain answers and the page's demo brain does, with the remedy.
  A pinned brain that is not ready is the same "none", never another brain. An unverified brain
  answers only an explicit pin (`resolve` refuses it under `auto`). In the chip a brain that is
  not ready cannot be picked.
- **`claude`** — `brains/claude.ts`, `claude-child.ts`, `claude-catalog.ts`: the pre-registry
  shim moved, its argv literal, pool key and allowlist pinned unchanged.
- **`codex`** — `brains/codex.ts`, `codex-events.ts`: readiness from `codex login status` (ready
  only on the ChatGPT login line); the catalogue from `codex debug models --bundled`; one think =
  one child, spawned detached with the posture argv, the system prompt as one
  `-c developer_instructions=<TOML basic string>`, the conversation on stdin; the allowlist
  tripwire (`agent_message`, `reasoning` dropped; `error` a named failure; anything else kills the
  process group and fails the think); the answer buffered until `turn.completed`; failures as
  fixed sentences. Fixtures under `apps/host-mcp/src/__tests__/fixtures/codex/` are recorded from
  the real CLI 0.160.0 logged out, and the success stream is transcribed — `PROVENANCE.md` there
  says which is which. **`CODEX_VERIFIED_VERSIONS` is empty**, so the chip lists Codex as
  "experimental — not yet verified on this machine". The owner's walk is printed in the header of
  `apps/host-mcp/src/__tests__/brain-live.test.ts` (`SNUG_LIVE_BRAIN=codex`) and in
  [the owner's walks](../runbooks/owner-walks-host-bindings.md), track C; a version goes into the
  list only after that walk is journaled for it.
- **The wire.** `/status` and the `status` event carry `brains[]` and `active`
  (`apps/host-mcp/src/__tests__/fixtures/status-wire.json`, read by the process's and the page's
  tests); the chat body takes `brain` and per-brain `prefs`; the answer names its brain in
  `x-snug-brain`; a think no brain can take is a 503 `no-brain`, and the page's demo brain
  answers.
- **Deferred:** `ollama`, `hermes`, `openclaw` and the Hermes walk (S5) — queued in
  `docs/next-steps.md` (2026-10-04) with §2's rule each must meet.
- **The decisions index's summary of `auto`** ("the spawning host's brain, else the first ready
  one") was the pre-review wording; §4 and the code are as above.

## Amendment (2026-10-04, TASK-20261003 Gate 5)

- **One "measured" fact in the Context was transcribed.** The `codex login status` bullet lists,
  among the facts measured on 2026-10-03, that logged in the CLI "names the method (`Logged in
  using ChatGPT` is the subscription)". Only the logged-OUT run was measured. The logged-in
  line was TRANSCRIBED from upstream: `run_login_status` in `codex-rs/cli/src/login.rs` at tag
  `rust-v0.160.0` prints `Logged in using ChatGPT` with `eprintln!` (stderr) and exits 0, and the
  API-key branch prints `Logged in using an API key - <first 8 characters>***<last 5>`
  (`apps/host-mcp/src/__tests__/fixtures/codex/PROVENANCE.md`; the constants
  `CODEX_LOGIN_STATUS_CHATGPT_TRANSCRIBED` and `CODEX_LOGIN_STATUS_API_KEY_TRANSCRIBED` in
  `fixtures/fake-codex-child.ts`). §3's "`ready` only when it reports the ChatGPT login" rests on
  that transcription until the owner's walk (track C, step 1, of
  [the owner's walks](../runbooks/owner-walks-host-bindings.md)) records the real output as
  `login-status-chatgpt.recorded.*`. If the real CLI prints something else, a logged-in Codex
  reads as not ready — it fails safe. The driver (`apps/host-mcp/src/brains/codex.ts`) reads any
  other `Logged in using …` line at exit 0 as the API-key case: `logged-out`, with the sentence
  "Snug uses your ChatGPT login, not an API key". Per the Gate 5 reading of the same upstream
  function, it has more logged-in lines than these two (other auth modes); for those the
  driver's state is still right (not ready) and its sentence is imprecise.
- **The walk names the version the way the list is matched.** `CODEX_VERIFIED_VERSIONS` is
  compared with the bare number the driver parses from `codex --version` (`codex-cli 0.160.0` →
  `0.160.0`). The walk's report now prints that number — `the Codex walk — 0.160.0` — and its
  PASS line names the exact entry, `add '0.160.0' to CODEX_VERIFIED_VERSIONS`; a walk whose
  `codex --version` the driver cannot read ends `verdict: FAIL`
  (`apps/host-mcp/src/__tests__/fixtures/codex-walk.ts`). `brain-codex.test.ts` fails any list
  entry the driver's parse would not yield, so the raw `codex-cli 0.160.0` cannot be pasted in
  and leave Codex unverified with every test green.

### Amendment (2026-10-05, the owner's B7 walk — TASK-20261003-host-bindings-complete)

- **The walk FAILED, and the finding changes §3.** A canary in the owner's real `~/.codex/AGENTS.md` came back in every answer; no command ran and no tool item fired. Codex loads the GLOBAL `AGENTS.md` of whatever home it runs with into every think — the project-doc switch (`project_doc_max_bytes=0`) holds, `--ignore-user-config` covers `config.toml` only, and nothing turns the global loader off (measured offline, `codex debug prompt-input`; `fixtures/codex/prompt-input-*.recorded.json`).
- **Decided by the owner:** the `codex` driver runs every child with Snug's OWN `CODEX_HOME` (`<Snug home>/host/codex-home`, created `0700`), logged in once by `CODEX_HOME=<it> codex login` — the remedy the brain menu shows. §3's "CODEX_HOME is not forwarded: Codex finds its login through HOME" is superseded: the parent's `CODEX_HOME` is still never forwarded; the driver sets its own. Rejected: copying or linking the user's `auth.json` (custody of a token; refresh-token rotation logs one side out).
- `CODEX_VERIFIED_VERSIONS` stays empty until the walk is re-run against this and journaled.
