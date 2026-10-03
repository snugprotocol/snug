# 0071 — The brain registry: any agent the user already has may answer, and none of them may act

- **Status:** accepted (owner-delegated, 2026-10-03: the task's ask was "make your own decisions"; Q2, Q3 and Q9 of the task file are the defaults taken here, each reversible by one word)
- **Date:** 2026-10-03
- **Task:** TASK-20261003-host-bindings-complete
- **Amends:** ADR-0069 §1 and §5 (the brain axis gains its remaining members and one contract) · ADR-0070 (the model/effort choice becomes per brain) · ADR-0065 §4 / D15 (narrowly: a pin among brains the machine already has) · ADR-0068 §5 (the shim is one driver of several)

## Context

ADR-0069 named two axes — where the body runs (the binding) and what answers the thinks (the brain) — and built one brain for Binding B: the user's own `claude` CLI as a tool-less child. Its remainder was "`codex exec` / Hermes / OpenClaw / Ollama". The code had no seam for a second one: `claude` is hard-wired into the binary lookup, the argv, the child class, the probe, the catalogue and the page's labels; the only provider-neutral thing is the three-method `Brain` interface the chat route calls.

Researched 2026-10-03 against each project's own documentation and source (none is installed on the owner's machine; every flag is re-checked against a real binary before it is pinned in a test):

- **Codex CLI** (`codex exec --json`) has **no single "no tools" switch** (the request is open upstream). Tools are features disabled one by one (`shell_tool`, `unified_exec`, `view_image`, `apps`, `plugins`, …), web search is a config key, user MCP servers are dropped by `--ignore-user-config`, and the read-only sandbox still lets the model read files and run commands. `exec --json` emits whole messages, never token deltas; `codex login status` distinguishes a ChatGPT login from an API key.
- **Hermes** (`hermes gateway`, `127.0.0.1:8642`) and **OpenClaw** (`:18789`, the OpenAI endpoint off by default) answer an OpenAI-shaped request by running **a full agent turn with the agent's own tools** — Hermes' documentation says "including terminal commands", OpenClaw's says to treat the endpoint "as full operator access". Hermes layers a caller's system message on top of its own; neither documents a zero-tool mode for the endpoint.
- **Ollama**'s OpenAI-compatible route cannot set the context window, whose default can be 4k tokens, and an over-long prompt is truncated silently with a 200.

The second finding is the decision's centre. An app's think is **untrusted input**: apps are LLM-written, may arrive by a shared link, and run in a sandbox precisely because nobody vouches for them (C2). If the brain that reads that input can run a shell, read files or browse, the sandbox has a door — a confused deputy holding the user's own agent's powers. ADR-0068 forbade a data-plane tool for the *agent* for this reason ("an agent that can fetch with the user's credentials … is a principal C1 forbids"); D5's `--tools ''` is the same rule seen from the brain's side. A second brain must not quietly repeal it.

## Decision

1. **One contract.** A brain is a `BrainDriver`: `id`, `name`, `via` (whose it is, in words), `probe()` → readiness, `catalog()` → models and thinking levels in the brain's OWN vocabulary, `create()` → the existing `Brain { stream, complete, stop }`. The registry holds the drivers, resolves which one answers a think, and reports all of them on `/status`. `claude` is its first driver and is behaviour-identical: the frozen argv, the pool key, the env allowlist and every existing test pass unchanged.

2. **No brain may act.** Every driver answers **tool-free by construction**, and the construction is ours, not the agent's promise:
   - `claude` — `--tools '' --disallowedTools '*' --max-turns 1` (ADR-0068 §5, unchanged).
   - `ollama` — a bare model; the driver never sends `tools`.
   - `codex` — every tool feature disabled, web search disabled, user config and rules ignored (which drops MCP servers), project docs off, the read-only sandbox, a neutral empty working directory, an ephemeral session; **and a tripwire**: the driver reads the event stream, and the first tool-shaped item (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `collab_tool_call`) kills the child and fails the think by name. An answer is delivered only when no tool item was seen, so no tool result can reach an app whatever a flag turns out to do.
   - `hermes`, `openclaw` — the gateway is asked for a tool-less run and **must prove it**: the driver reads the agent's own configuration and capabilities, and only an agent profile with no tools is `ready`. A gateway that would answer with tools is reported `needs-setup` with the one change that makes it safe; it is listed on the chip and cannot be selected.
   A driver's posture is a frozen literal in a test. This is D5 generalised, and it is not a control: there is no "allow tools" switch.

3. **Credentials stay process-side.** A gateway token (Hermes' `API_SERVER_KEY`, OpenClaw's `gateway.auth.token`) is read by the process from the agent's own config, by name, used on a loopback request, and never sent to the page, written, logged or echoed; every error passes `scrubAuthValues`. No driver passes the parent environment to a child (the allowlist), and no API-key variable is ever forwarded — a brain on a key is not "the user's own agent" (D15).

4. **Selection is `auto`, with a pin.** `auto` resolves per think: the brain of the host that spawned the runner (`--host <id>`, written by the manifest that names the launcher) when it is ready, else the first ready brain in the fixed order `claude → codex → hermes → openclaw → ollama`, else none — and then the demo brain answers and the chip says which brains were looked for. The user may pin any READY brain from the chip; the pin is per machine, beside the model and effort (ADR-0070 §5), never in the user file. This amends D15 narrowly, as ADR-0067 and ADR-0070 did: the kit still never *asks* — no key, no URL, no account, no mode — and a brain that is not ready cannot be picked.

5. **The model and the thinking level are per brain, in that brain's words.** Claude's `--effort`, Codex's `model_reasoning_effort`, Ollama's `think` are three vocabularies; nothing maps one onto another (ADR-0070 §3's rule). A brain with no such axis offers no control. What ANSWERED is shown, never what was asked (ADR-0059 rule 2).

6. **HTTP drivers parse, never pass through.** Upstream SSE or NDJSON is decoded and re-emitted as whole `JSON.stringify`'d frames; only answer text is forwarded (reasoning stays private, as `thinking_delta` does); the destination is loopback by construction and no redirect is followed; the first-byte and idle bounds name themselves; a client abort cancels the upstream request.

7. **Ollama's window is sized per request.** The driver uses the native `/api/chat` so it can set `num_ctx` from the prompt's size against the model's own `context_length`; a prompt the model cannot hold is refused by name, never truncated. The brain reports `maxPromptBytes`, so the builder budgets or refuses (ADR-0066) on a small local model as it does under an artifact.

8. **Readiness names seven states**: `ready | logged-out | outdated | absent | stopped | needs-setup | unknown`, each with one sentence a person can act on. `stopped` is an installed daemon that is not running; `needs-setup` is an agent that would answer with tools, an endpoint that is switched off, or an Ollama with no model.

## Alternatives considered

- **Pass a request through to the agent's gateway as it is.** Rejected: it hands a sandboxed app the agent's terminal. The original T3 text said "passthrough"; it was written before anyone asked what the far side does with a prompt.
- **A disclosed "this brain can act" mode.** Rejected: a disclosure does not bound a confused deputy, and the user who reads it is not the one who wrote the app.
- **Trust Codex's feature flags alone.** Rejected: only one of them has been observed to remove its tool. The tripwire makes the invariant ours.
- **The Codex app server (warm, streaming).** Deferred: experimental upstream; `exec` is the documented single-shot. Its cost is whole-message delivery.
- **Ollama's OpenAI-compatible route.** Rejected: it cannot set the window, and silent truncation of a builder prompt is the failure ADR-0066 exists to prevent.
- **No pin; `auto` only.** Rejected: two hosts can share one runner (one process, one file), so "the host's brain" is not always one brain, and a user with both Claude and a local model has a real preference.

## Consequences

- Positive: a Cowork user with no Claude CLI but with Ollama or Codex has a brain; one vocabulary for readiness; a second brain is a file, not a rewrite; the sandbox boundary does not depend on which agent the user owns.
- Negative / residuals: Codex answers arrive whole, not streamed; a Hermes or OpenClaw user must make one configuration change before their agent can be a brain, and Snug says which; a gateway token is read from another product's config file (transit-only, R-row added); Codex's posture is verified against a logged-in CLI only by the opt-in live test until the owner walks it; small local models build poor apps, and `auto` puts them last.
- Docs owed (this task): the threat-model delta (the brain as a principal; the gateway token; the tripwire), architecture, code-map, glossary ("brain driver", "host hint"), the program record's T3 row, ADR-0069/0070 status lines.
