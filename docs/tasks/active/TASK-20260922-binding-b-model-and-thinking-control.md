# TASK-20260922-binding-b-model-and-thinking-control: the brain chip on Binding B becomes a control — the user picks the model and the thinking level, and sees which are active

- **Status**: draft — specced at the close of TASK-20260913 from the owner's ask on walk #1; **not started, nothing implemented**. Gate 1 (spec + plan approval) is the first act.
- **Owner**: Jeetu
- **Risk tier**: **high** — it changes the child CLI's argv (the brain's security posture, program D5), the pool's identity key, and the one disclosure surface D15/ADR-0059 govern. Plan review with fresh-context finder angles before code; explicit sign-off at Gate 5.
- **Branch**: `feat/TASK-20260922-binding-b-model-and-thinking-control` off `main` **after PR #181 merges**
- **Packages touched** (anticipated): `apps/host-mcp` (`brain-claude.ts` — `buildStreamArgs`, the `POSTURE` constant, `createClaudeBrain`; `brain-child.ts` — the pool key, possibly `thinking_delta` handling; `loopback-server.ts` — the chat route's request shape; a new capability/probe surface), `apps/host` (`src/local/compose-local.ts` — `brainLabel` becomes a control), `packages/protocol` **only if** the seat is declared in the schema (see AC6 — decide at Gate 1)
- **Spec impact**: **none expected, TO BE CONFIRMED at Gate 1.** If the choice rides in the bundle/seat rather than as a host preference, `packages/protocol` changes → spec-changelog entry + SPEC_SYNC plan. Answer Q2 before writing code.
- **Related**: **ADR-0067** (the same question, answered for Binding A — read it first: it amended D15 narrowly, and this task is its Binding B sibling), ADR-0069 §5 (the pool, the posture), ADR-0068 (D5, the child env allowlist), ADR-0059 (the chip is disclosure), ADR-0036 (the per-app model selector — a THIRD, older picker; check what it already decided), TASK-20260913 journal 2026-09-22.

## Spec (what & why)

**What.** On Binding B the runner's brain chip says `Claude · your CLI` and is a **label**: `brainLabel()` in [compose-local.ts:73-89](../../apps/host/src/local/compose-local.ts#L73-L89) returns a string for each of five states, and clicking it does nothing. The owner asks for a control: pick **any model the user's Claude Code supports**, pick the **thinking level**, and on click see the **currently active** model and level.

Today none of that exists in the path, verified by reading the code on 2026-09-22:

- **No model is ever chosen.** `buildStreamArgs(system)` ([brain-claude.ts:96](../../apps/host-mcp/src/brain-claude.ts#L96)) builds the one argv and **never passes `--model`** — every child runs on the CLI's default model.
- **The model field is decoration.** `const model = request.model ?? 'claude'` ([brain-claude.ts:253](../../apps/host-mcp/src/brain-claude.ts#L253)) only fills the response envelope; its own comment says "The page sends no model today (it always says `claude`)".
- **Thinking is deliberately private.** Only `text_delta`s are forwarded; a user's own extended-thinking setting emits `thinking_delta`s that are dropped ([brain-child.ts:175](../../apps/host-mcp/src/brain-child.ts#L175)).
- **The seams exist.** The pool keys on `sha256(system)` ([brain-child.ts:225](../../apps/host-mcp/src/brain-child.ts#L225)) and its comment already anticipates this task: "a different model would be a different child".

**Why now.** The owner asked on the first real walk of the shipped plugin. It is also the one part of Binding B where the user has visibly less control than on Binding A, which got exactly this control in ADR-0067.

**The constraint that must not be lost.** The call is **structurally single-turn** and that is a security posture, not an omission. `POSTURE` ([brain-claude.ts:67-86](../../apps/host-mcp/src/brain-claude.ts#L67-L86)) spawns every child with `--tools '' --disallowedTools '*' --max-turns 1 --no-session-persistence`: no tools means no agent loop (`num_turns: 1` verified). A brain with tools would hold the user's own CLI capabilities under their login — precisely the principal C1 forbids. **This task must not widen the posture**, and an AC pins that it hasn't.

**Acceptance criteria** (each becomes at least one test; 🔑 = owner walk):

1. **The model reaches argv.** `buildStreamArgs` takes the chosen model and emits `--model <id>`; absent a choice the argv is **byte-identical to today's** (so the default path is provably unchanged).
2. **The pool key includes the model.** `sha256(system + model)` — a model switch yields a different child; a pre-warmed child for model A is never handed to a request for model B. Pin with a test that would fail under today's key.
3. **The list is not hardcoded.** The offered models come from the user's own CLI, not a literal in our source (see Q1 — this is the recommendation, not yet decided). Rationale: a hardcoded list guarantees staleness, and this CLI has already broken once on exactly that (2.1.211's `400 … version 2.1.251 or newer is required`). Whatever the mechanism, a model the CLI does not support must fail by NAME, never silently answer on another.
4. **The thinking level is chosen and honoured.** The level reaches the child; the active level is readable back for the chip. Decide against ADR-0067's vocabulary (`auto | quick | default | complex`) versus whatever this CLI actually exposes — they may not be the same axis, and inventing a mapping that doesn't exist is the failure mode to avoid.
5. **The chip shows what is ACTIVE, not what was asked.** On click: the current model and level, derived from what the brain actually ran with (ADR-0059 rules 2 and 4 — never parallel UI state). If a request was substituted or refused, the chip says so in words. The five existing states keep their remedies; a control never replaces a remedy.
6. **The choice's home is decided and tested** (Q2): a host preference (this machine) or app-scoped (rides the seat/bundle, travels with the app). Per-app means `packages/protocol` and a spec-sync step; per-machine does not.
7. **The posture is unchanged.** A test pins that `--tools ''`, `--disallowedTools '*'`, `--max-turns 1`, `--no-session-persistence`, `--setting-sources local`, `--strict-mcp-config` and the never-`--bare` rule all still hold with a model and level selected. The release gate's whole-env read count stays as it is.
8. **No dead control.** Where the brain is not `ready` (logged-out / outdated / absent / unknown) or a level/model cannot be offered, the chip renders no control — the ADR-0067 rule. The demo brain gains nothing.
9. 🔑 **Owner walk**: on the real runner, switch model mid-session and confirm the next think uses it; switch thinking level and confirm the same; confirm the chip names both; confirm a bad/unsupported model is refused in words rather than silently answered.

**Out of scope**: transcript continuation and multi-turn/tool-using brains (that is a posture change — its own task and ADR, and it must not be smuggled in here); the other CLIs (`codex`/`hermes`/`openclaw`/`ollama` — T3's remainder, though Q1's mechanism should not make them harder); Binding A's tier control (shipped, ADR-0067); ADR-0036's per-app selector unless Gate 1 finds it already answers Q2.

## Open questions (answer at Gate 1, before code)

- **Q1 — Where does the model list come from?** Ask the CLI (robust, costs a spawn, needs a cache and a refusal path when the answer is unparseable) / a pinned list in `install-roots.json`-style config (cheap, goes stale — the failure already seen once) / free-text entry with validation at first use. **Recommendation: ask the CLI, cache per CLI version, and fail by name.** Requires a spike: does the installed `claude` expose a machine-readable model list at all? **Answer this before anything else — the whole shape depends on it, and if the answer is "no", AC3 needs rewriting.**
- **Q2 — Per-machine preference or per-app?** Per-app travels with a user-owned file and matches "the app is yours"; per-machine matches ADR-0067's "a viewer preference, like theme, not file content". They pull opposite ways and one of them touches the protocol. **Recommendation: per-machine first** (no spec impact, reversible), with per-app recorded as a follow-up if the owner wants the app to carry it.
- **Q3 — What is the thinking-level axis on THIS binding?** ADR-0067's `quick|default|complex` is the artifact runtime's `modelTier` contract. The CLI's thinking control may be a different mechanism entirely. **Do not assume they map**; find the real one and name it in the ADR.
- **Q4 — Does the thinking control change the privacy decision?** `thinking_delta`s are suppressed today. A user-facing level either (a) keeps them private and only changes cost/latency — which risks an invisible spend the user cannot see the effect of — or (b) surfaces them, which is a new disclosure. **Recommendation: keep them private at v1 and say on the chip that thinking is not shown**, so the control is honest about what it does.
- **Q5 — Does a switch spend anything?** ADR-0067 rule 3 says a switch costs no call; it takes effect on the NEXT turn. **Recommendation: same here**, plus a note that switching evicts a pre-warmed child (a real cost in warm-up latency, not tokens) — say so or absorb it.

## Plan

Not written. Gate 1 is: answer Q1–Q5 (Q1 needs the spike first), then write the plan with tests first, then the owner approves before any implementation.

## Decisions & surprises

- (2026-09-22, from TASK-20260913) The single-turn posture is load-bearing and deliberate; see the Spec's constraint note. Any reviewer who reads "model selection" as "make the brain agentic" should be pointed at AC7.

## Session journal (append-only, newest last)

### 2026-09-22 — Jeetu (via Claude Code) — spec written at the close of TASK-20260913
- Done: task specced from the owner's ask during AC9 walk #1; the current behaviour read from the code and cited by file and line; ADR-0067 identified as the governing precedent.
- State: **draft, nothing implemented, no branch cut.** PR #181 must merge first (this branch cuts off the `main` that carries it), and the Q1 `host-mcp` → `local-host` rename PR is also queued ahead of it — expect these file paths to move.
- Next step: Gate 1 — the Q1 spike (does the user's `claude` expose a machine-readable model list?), then answer Q1–Q5, then the plan.
- Open questions: Q1–Q5 above, all unanswered.
