# TASK-20260922-binding-b-model-and-thinking-control: the brain chip on Binding B becomes a control — the user picks the model and the thinking level, and sees which are active

- **Status**: **Gate 1 CLOSED 2026-09-22** — Q1–Q5 answered (spike + owner), AC3 rewrite approved, plan written. **No implementation yet**; the plan awaits owner approval (Gate 2) before code.
- **Owner**: Jeetu
- **Risk tier**: **high** — it changes the child CLI's argv (the brain's security posture, program D5), the pool's identity key, and the one disclosure surface D15/ADR-0059 govern. Plan review with fresh-context finder angles before code; explicit sign-off at Gate 5.
- **Branch**: `feat/TASK-20260922-binding-b-model-and-thinking-control` — **cut** off `main` at `ff20cba` (PR #181 `df68d63` + done-move #182 both landed)
- **Packages touched** (anticipated): `apps/host-mcp` (`brain-claude.ts` — `buildStreamArgs`, the `POSTURE` constant, `createClaudeBrain`; `brain-child.ts` — the pool key, possibly `thinking_delta` handling; `loopback-server.ts` — the chat route's request shape; a new capability/probe surface), `apps/host` (`src/local/compose-local.ts` — `brainLabel` becomes a control), ~~`packages/protocol`~~ **not touched** (AC6 decided at Gate 1: per-machine)
- **Spec impact**: **NONE — CONFIRMED at Gate 1.** Owner chose per-machine, global across apps, never written to the user file, so `packages/protocol` is untouched: no spec-changelog entry, no SPEC_SYNC step.
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

**Gate 1 is closed** (Q1–Q5 answered in the journal). Per-machine, global across apps, **no `packages/protocol` change**. The axis is the CLI's `--effort low|medium|high|xhigh|max`; the model is free text validated at first use.

Tests first at every step. Steps 1–4 are `apps/host-mcp`; step 5 is `apps/host`; step 6 is the ADR and the owner walk.

**S1 — the spawn spec (one value, so argv and key cannot drift).** Replace the bare `system: string` threaded through `poolKey`, `argsFor`, `acquire`, `prewarm` and `spawn` with a `BrainSpec { system: string; model?: string; effort?: Effort }`.
- Tests: `buildStreamArgs` with no model/effort is **byte-identical to today's argv** (AC1's default-path proof — assert against a frozen literal, not a recomputation); with a model it emits `--model <id>`; with an effort it emits `--effort <level>`; an unknown effort value never reaches argv.

**S2 — the pool key covers the spec (AC2).** `poolKey(spec)` = `sha256(system + '\u0000' + model + '\u0000' + effort)` (a separator, so `model:"a"`+`effort:"b"` cannot collide with `model:"ab"`).
- Tests: two specs differing ONLY in model yield different keys; likewise effort; a pre-warmed child for model A is never handed to a request for model B (drive `acquire` twice and assert the second spawns); same spec still reuses the warm child (the pre-warm win is not lost). At least one test must **fail under today's `sha256(system)`** — run it against the old key to prove it.

**S3 — the child remembers what it resolved (the finding above, AC5).** In `onEvent`, capture `system/init`'s `model` into a field on the child **before** the `pending === undefined` early-return, so a pre-warmed child's resolved model survives to its turn. Surface it on `TurnResult` as `resolvedModel`, plus `effort` as asked.
- Tests: a child fed an `init` frame while idle (no pending) still reports its resolved model on the next turn — this is the pre-warm case and the one that fails today; a turn whose CLI resolved a different model than asked reports the RESOLVED one; a stream with no `init` frame reports nothing rather than echoing the request (never invent a disclosure).

**S4 — the brain refuses a bad model by name (AC3).** `createClaudeBrain` passes the chosen model/effort into the spec, and maps the CLI's `unrecognized_model` failure to a refusal naming the model. Stop filling the envelope with `request.model ?? 'claude'`; report what ran.
- Tests: a child erroring with the measured `[claude-code:unrecognized_model]` text surfaces a refusal **containing the offending model name**; the refusal does not fall back to another model; the envelope's `model` is the resolved id, not the asked string.

**S5 — the store and the chip (`apps/host`, AC5/AC8).** A `brainChoiceStore` beside `tierStore.ts`, same shape and same rules: `localStorage`, per-machine, **never written to the user file, never exported**. `brainLabel()` in `compose-local.ts` gains a control that lists the efforts, takes a model as free text, and on click shows the ACTIVE model and effort from what the brain reported.
- Tests: the store persists and rejects a non-effort value; storage that throws degrades to memory-for-this-boot (the Safari rung `tierStore` already handles); **no control is rendered where the brain is not `ready`** — logged-out / outdated / absent / unknown keep their remedies untouched (AC8), and the demo brain gains nothing; the chip shows the resolved model, and says so in words when one was refused or substituted.
- **AC7 pin (belongs here and in S1):** a test asserting `--tools ''`, `--disallowedTools '*'`, `--max-turns 1`, `--no-session-persistence`, `--setting-sources local`, `--strict-mcp-config` and never-`--bare` all still hold **with a model and effort selected**, and that the release gate's whole-env read count is unchanged.

**S6 — ADR + walk.** An ADR recording: the `--effort` axis and why it is NOT ADR-0067's `modelTier` (do not map them); per-machine storage and why not the user file (a model id that travels can break on arrival); free text rather than a list, because no queryable list exists and the CLI fails by name; thinking stays private at v1 while `thinking_tokens` counts keep cost honest (Q4); a switch spends no tokens, lands on the next turn, and **says** it evicts a pre-warmed child (Q5).
- Then AC9, the owner walk: switch model mid-session and confirm the next think uses it; switch effort and confirm the same; confirm the chip names both; confirm a bad model is refused **in words**.

**Loose end, not blocking:** `apps/host-mcp` has no row in `docs/engineering/TDD.md` (Binding B landed after that table). Add one in S1's commit.

## Decisions & surprises

- (2026-09-22, from TASK-20260913) The single-turn posture is load-bearing and deliberate; see the Spec's constraint note. Any reviewer who reads "model selection" as "make the brain agentic" should be pointed at AC7.

## Session journal (append-only, newest last)

### 2026-09-22 — Jeetu (via Claude Code) — spec written at the close of TASK-20260913
- Done: task specced from the owner's ask during AC9 walk #1; the current behaviour read from the code and cited by file and line; ADR-0067 identified as the governing precedent.
- State: **draft, nothing implemented, no branch cut.** PR #181 must merge first (this branch cuts off the `main` that carries it), and the Q1 `host-mcp` → `local-host` rename PR is also queued ahead of it — expect these file paths to move.
- Next step: Gate 1 — the Q1 spike (does the user's `claude` expose a machine-readable model list?), then answer Q1–Q5, then the plan.
- Open questions: Q1–Q5 above, all unanswered.

### 2026-09-22 — Jeetu (via Claude Code) — /pickup: baseline verified, Q1 spike RUN
- Context check: PR #181 (`df68d63`) and done-move #182 (`ff20cba`) are both on `main`; no task branch cut yet; working tree clean but for an untracked `Claude outputs/`. The queued `host-mcp` → `local-host` rename has NOT happened — paths in this task file are still accurate.
- Baseline tests GREEN on `main` before any change: `host-mcp` 271 passed / 1 skipped; `host` 228 passed. (`host-mcp` has no row in `docs/engineering/TDD.md` — Binding B was added after that table; adding one is a loose end.)
- Re-verified every code claim in the Spec against the tree (buildStreamArgs never passes `--model`; `request.model ?? 'claude'` is envelope-only; `thinking_delta` dropped; pool keys on `sha256(system)`). All four still hold.
- **Q1 SPIKE RESULT — measured on claude 2.1.278, under the FULL D5 posture.** Answers Q1 and reshapes AC3:
  - There is **no machine-readable model list**: no `claude model` subcommand, nothing in `Commands:`. So "ask the CLI for the list" (the spec's recommendation) is **not available** — AC3 does need rewriting, as the task anticipated it might.
  - But the property AC3 actually wants is **already guaranteed by the CLI**: an unknown model fails BY NAME, loudly, and never silently answers on another. Measured stderr: `"definitely-not-a-model-xyz" isn't described by this version's model catalog…` plus a structured tag `[claude-code:unrecognized_model] {"model":"…","query_source":"sdk"}`. So free-text entry + validation-at-first-use is safe, and a hardcoded list is unnecessary rather than merely stale.
  - `--model` accepts an **alias** (`fable`, `opus`, `sonnet`, `haiku`) or a full name (`claude-fable-5`) — per `--help`.
- **Q3 ANSWERED — the thinking axis on this binding is `--effort <level>`, values `low, medium, high, xhigh, max`.** This is a REAL CLI flag, and it is NOT ADR-0067's `quick|default|complex`, which is the artifact runtime's `modelTier` contract ([tierStore.ts](../../apps/host/src/brains/tierStore.ts)). Q3's warning was right: they do not map. Do not invent a mapping; name `--effort` in the ADR.
- **AC5 is cheap — the CLI already discloses what ACTUALLY ran**, on the same stream-json wire the brain reads today:
  - frame 0 is `{"type":"system","subtype":"init","model":"claude-haiku-4-5-20251001","tools":[]}` — the RESOLVED model, arriving BEFORE the first token, so the chip can name it early. (It also re-proves the posture: `tools: []`.)
  - the `result` frame carries `modelUsage` keyed by resolved id with `canonicalModel`, and `num_turns: 1` — so AC7's single-turn pin is verifiable from the same frame.
  - This means AC5's "derived from what the brain actually ran with" needs no new probe: read `init.model`, never echo the request.
- **Q4 has a new wrinkle (measured):** with `--effort low`, the child emits `system/thinking_tokens` frames (`estimated_tokens`, `estimated_tokens_delta`) ALONGSIDE the `thinking_delta`s we drop. That is a token COUNT without the thinking CONTENT — so the "invisible spend" risk in Q4 can be answered without surfacing any thinking text. Recommendation stands (keep thinking private at v1) but it can now be honest about cost, not just silent.
- Posture note: `--model` and `--effort` both compose with the full D5 argv (`--tools '' --disallowedTools '*' --max-turns 1 --no-session-persistence --setting-sources local --strict-mcp-config`) with no widening — measured `num_turns: 1` and `tools: []` with both flags set.
- Q2 and Q5 remain **unanswered** — they are owner/design calls, not spike questions.
- Next step: Gate 1 — owner to confirm Q2 (per-machine vs per-app) and Q5 (switch cost / evicting a pre-warmed child), and to approve rewriting AC3 around free-text-plus-named-failure now that no list exists. Then the plan, tests first.

### 2026-09-22 — Jeetu (via Claude Code) — Gate 1 ANSWERS (owner)
- **Q2 ANSWERED — per-machine, global across apps.** One choice for every app on this machine; **never written to the user file**, not exported, not saved into the page. So **`packages/protocol` is NOT touched**, there is no spec-changelog entry and no SPEC_SYNC step — the "Spec impact: none" line at the head of this task is now CONFIRMED, not "to be confirmed". This matches ADR-0067's Binding A precedent exactly (a viewer preference, like theme). Owner considered and rejected storing it in the snug file: a model id that travels to a machine whose CLI lacks it would be a choice that breaks on arrival.
- **Q3 ANSWERED — `--effort <level>`, values `low|medium|high|xhigh|max`** (owner took the recommendation). It is the CLI's own flag, measured in the spike. It is NOT ADR-0067's `quick|default|complex` (the artifact runtime's `modelTier` contract) and **no mapping between the two is to be invented**. The ADR names `--effort` and states why the axes differ.
- **AC3 APPROVED FOR REWRITE** — around free-text entry + validation-at-first-use, leaning on the CLI's own by-name failure (`[claude-code:unrecognized_model]`), because the spike proved no machine-readable list exists to query.
- **Q5 — taking the spec's recommendation** (not separately ruled by owner): a switch spends no tokens and takes effect on the NEXT turn (ADR-0067 rule 3), and the chip SAYS that switching evicts a pre-warmed child — disclosed rather than absorbed, since the cost is real warm-up latency the user would otherwise feel without explanation.
- Q1/Q4: answered by the spike above (no list; thinking stays private at v1, with `thinking_tokens` counts available to make cost honest without surfacing content).
- **Gate 1 is CLOSED.** Next: the plan, tests first, then owner approval before implementation.

### 2026-09-22 — Jeetu (via Claude Code) — pre-plan code read: one constraint the spec did not know
- Branch `feat/TASK-20260922-binding-b-model-and-thinking-control` cut off `main` at `ff20cba`.
- **FINDING (AC5, affects the design): the resolved-model frame is DROPPED on the pre-warmed path today.** `ChildLike.onEvent` early-returns while `this.pending === undefined` ([brain-child.ts:173](../../apps/host-mcp/src/brain-child.ts#L173)), and `pending` is only set when a request starts ([brain-child.ts:117](../../apps/host-mcp/src/brain-child.ts#L117)). But the `system/init` frame that names the resolved model is emitted at **spawn**, which for a pre-warmed child is minutes before its request arrives. So on the path Binding B is built around (`prewarm`), `init.model` is parsed and thrown away.
  - Consequence: AC5 cannot simply "read the init frame in the turn". The child must **remember its own resolved model at spawn** — a field on the child, set from `init` regardless of `pending`, read by the brain when the turn completes. This is a small change to `onEvent` but it is NOT the no-op the spike's "AC5 is cheap" note implied; correcting that here.
  - It also strengthens AC5: what the child remembers is what the CLI resolved for THAT child, so a substituted model is disclosed per child rather than guessed.
- Shape confirmed for the plan: `system` is threaded as a bare `string` through `poolKey(system)`, `argsFor(system)`, `acquire(system)`, `prewarm(key, system)` and `spawn(system)`. Adding a model+effort means threading a small **spawn spec** object through all six, so AC2's key and AC1's argv derive from ONE value and cannot drift apart.
- `TurnSink` is `onDelta(text)` only; `TurnResult` is `{ text, stopReason }`. AC5's disclosure rides back on `TurnResult` (a new field), not on the sink — the chip wants it once per turn, not per delta.

### 2026-09-22 — Jeetu (via Claude Code) — S1 begins; ADR-0036 read (the loose end I flagged)
- **ADR-0036 does NOT override Q2 — it CORROBORATES it.** 0036 governs a different binding (the playground's four provider lanes, stored at `snug_settings['appModel:<appId>']` in the user DB), so it decides nothing for Binding B's CLI brain. But its **D1 ("the model does NOT ride `RuntimeContract`", rejected)** reached the owner's Q2 answer independently, and its third bullet is the owner's own reasoning in different words: putting a model preference in app content would "export/import as app content — carrying one user's model preference into another user's file." Cite 0036 D1 in the S6 ADR as prior art; per-machine is now the project's second, consistent answer to the same question, not a one-off.
- Two more 0036 rules carry over and are folded into the plan's tests:
  - **Rule 3, "resolution happens PER SEND, never at construction"** — a memoized transport freezes the choice until reload. Our equivalent: resolve model+effort **per `acquire`**, never captured when the pool or brain is constructed. AC9's "switch mid-session and the NEXT think uses it" is exactly this rule, and it gets its own test in S2.
  - **Rule 4, "the control says so by absence"** — under a brain that cannot route the choice, render nothing rather than a dead control. Identical to our AC8 and to ADR-0067; three ADRs now agree, so S5 follows it without re-litigating.
- Starting S1: the spawn spec, tests first.
