# TASK-20260804-observability-caching: live LLM observability, prompt caching, brand polish

- **Status**: ✅ done — merged to `main` via PR #4 (`db12419`) on 2026-08-05. 906 tests, build 9/9, Playwright 30/30.
- **Owner**: Jeetu
- **Risk tier**: **high** (auto-escalated: `packages/adapters` is the C1 LLM choke point and gains cache-control on every request; `apps/server` request shaping. Widely-depended packages `adapters` + `protocol`-adjacent types)
- **Branch**: `feat/TASK-20260804-observability-caching`, to be cut off the current branch (`feat/TASK-20260804-hub-polish`) — see D1
- **Packages touched**: `packages/adapters`, `apps/playground`, `apps/server` (subscription-mode caching only)
- **Spec impact**: **none intended** — no `packages/protocol` schema change. `AgentRoundTrip`/`TokenUsage` are adapter-level types, not wire protocol (see D2).
- **Related**: TASK-20260804-hub-polish (direct parent — built the LLM inspector this task rebuilds), ADR-0008 (serverless/BYOK LLM bridge), ADR-0011 (LLM-optional apps), `docs/lessons.md` 2026-08-04 (vacuous tests; single-use streams)

## Spec (what & why)

Six items from using the hub. Items 3–6 all rewrite the same surface (the LLM round-trip panel in both the run rail and the build view), so they are specified together and implemented as one coherent redesign rather than six patches.

**Verified against the code before planning:**
- The round-trip panel today (`run/LlmInspectorPanel.tsx`) shows an index, stop reason, tool-call names, duration and tokens per entry, with `sent`/`received` bodies revealed on expand. It renders **only completed** round trips — `llmInspectorReduce` is fed by the adapters' `round_trip` event, which is emitted *after* `adapter.complete()` returns (`agent-turn.ts:86`). There is no in-flight state at all, which is why nothing appears until a call finishes (item 5).
- `TokenUsage` (`packages/adapters/src/types.ts:55-58`) carries **only** `inputTokens`/`outputTokens` — no cache fields and no model name. Both are needed for items 3 and 4.
- **No caching is configured anywhere.** The Anthropic adapter's request body (`anthropic.ts:100-113`) sends `model`/`max_tokens`/`system`/`messages`/`tools` with no `cache_control` on any block. Per the current API guidance: caching is a **prefix match** (`tools` → `system` → `messages` render order), max 4 breakpoints, and the minimum cacheable prefix is **model-dependent** — 1024 tokens on Sonnet 4.6/Sonnet 5, but **4096 on Opus 4.6/Haiku 4.5** and 512 on the newest models. Below the minimum it silently does not cache.
- Truncation today happens **at ingest** (`LLM_INSPECTOR_MAX_FIELD_CHARS` in `llmInspector.ts`), not at render — so "collapse instead of truncate" (item 3) means changing what is *stored*, which directly affects the AC14 memory bound the parent task fought for.

**Acceptance criteria** (each becomes at least one test):

*Brand & hub (items 1, 2)*
1. A starter tile opens on click of the **card** (matching the installed-app tiles), with no separate "open" button; the card is a single accessible control with a discernible name, and keyboard activation (Enter/Space) works.
2. Opening a starter still does **not** install it (the parent task's AC18 outcome tests stay green), and an installed starter still routes to the user's own copy.
3. `--text-brand` is reduced by 20% (2.5rem → 2rem) and the narrow-viewport token scales with it; the header still passes its 760px/830px rules with no overflow.

*Round-trip surface (items 3, 5, 6)*
4. Each round trip shows the **model name** as sent on the wire (not a UI guess), sourced from a new adapter-reported field.
5. Tools/skills invoked in a round trip are shown **nested under it**, each with its own elapsed time; the round trip continues to show total wall-clock plus input/output tokens.
6. `sent` and `received` are **collapsed by default**, expand to the **complete** payload (no ingest truncation of the expanded view), and each carries its **byte size** in the section header.
7. **AC14 is preserved under the new no-truncation rule**: the surface stays in-memory only (nothing to the user DB, localStorage or sessionStorage) and stays bounded. Because per-entry payloads are no longer truncated at ingest, the bound must come from a total-bytes budget with oldest-entry eviction — asserted by a test that pushes oversized payloads and observes eviction.
8. Round trips and tool calls appear **as they start**, with a live elapsed timer, and settle to their final state on completion — asserted by a test that observes in-flight state before the call resolves.
9. The redundant last-write-wins **pill** is removed from both the run rail and the build view and replaced by a single rotating animated status line. Per D0/Q1 the *factual* record is not deleted — it survives as the nested tools of AC5, so a build's actual actions remain inspectable after the fact.
10. Rotating status messages are **phase-appropriate and differ between first build and edit** of an existing app (planning/designing/building vs. adjusting/refining), asserted at the copy-selection level, not by scraping the DOM for specific strings.
11. The rotation respects `prefers-reduced-motion`: no animation and no message rotation when the user has asked for reduced motion (a11y, and the repo already honors this elsewhere).

*Caching (item 4)*
12. Prompt caching is enabled on the **builder/agent turns** (direct mode and the hub's `/invoke` path), with `cache_control` placed on the **stable prefix** (tools + system) — never on the volatile tail — following the prefix-match rule. Per D0/Q2 the small app-frame envelopes are deliberately **excluded**: they sit below the model-dependent minimum, so a breakpoint there would pay a 1.25× write premium on a prefix that is never read.
13. Cache hit/miss is reported through `TokenUsage` as new optional fields (cache-created and cache-read tokens) and surfaced in the UI as a **cached %** next to the in/out token counts, shown **only when the provider reported caching** (absent, not "0%", when it did not).
14. A negative test asserts caching is **not** requested from providers/endpoints that do not support it (local/Ollama), so a cache-control field never breaks a local turn — the parent task hit exactly this class of bug with `max_completion_tokens` on local.
15. **C1 holds**: no credential ever enters a cached block, a round-trip record, or the rendered panel — re-asserted at the new seams, including the new model-name and cache-usage fields.

**Out of scope**
- Any `packages/protocol` schema change; no spec-sync, no spec-changelog.
- Cost accounting in currency (tokens and cache % only — no pricing table, which would go stale).
- Caching for the **app-frame** transport's per-turn envelopes (they are short, self-contained, and below the cacheable minimum — see R3).
- Replacing the structural frame inspector (`run/inspector.ts` stays byte-identical, as in the parent task).
- Persisting any round-trip data (still forbidden).

## Plan

### D0 — Owner answers (2026-08-04 interview)

- **Q1 audit trail → replace the pill, keep the record.** The always-visible last-write-wins pill becomes the rotating animated status line; the *factual* step record survives as the **tools nested under each round trip** (AC5), each with its own elapsed time. Nothing that tells the user what actually ran is deleted — only the duplicate surface. This matters because subscription mode has no round-trip surface at all, so a pure-decoration answer would have left it with nothing but ambient text.
- **Q2 caching scope → builder/agent turns only.** Cache the tools+system prefix on the large, repeated builder and app-chat turns. **Do not** add `cache_control` to the small app-frame envelopes (a Chess move): they are self-contained, almost certainly below the model-dependent minimum, and would pay a 1.25× write premium on a prefix that is never read. AC12 is scoped accordingly and the app-frame path stays out of scope.
- **Q3 tool nesting → nest the tools that ran after it.** Each round trip renders the tools it requested, nested beneath it, each timed around its own handler execution. Recorded because it is subtly *not* what a round trip literally contains — the model requests tools at the end of round trip N and they execute between N and N+1 — so the nesting is a deliberate presentation choice, and the timing seam is the tool handler, not the LLM call.

### D1 — Branch base
The parent task (`feat/TASK-20260804-hub-polish`) is **not yet merged** and this task builds directly on its LLM inspector, `ThinkPanel`, and starter flow. Branching off `main` would conflict immediately. Proposal: branch off `feat/TASK-20260804-hub-polish` and merge it first, exactly as Phase A did last time.

### D2 — Decisions taken up front
- **No protocol change.** `AgentRoundTrip`, `TokenUsage`, and the model name are `packages/adapters` types consumed in-process; they never cross the app-iframe wire, so C3/spec-sync does not apply.
- **Caching goes on the stable prefix only.** Render order is `tools` → `system` → `messages`; a breakpoint on the last system block caches tools+system together. Putting a breakpoint on the volatile tail would write a new cache entry per request and never read one.
- **Truncation moves from ingest to render.** Item 3 requires the full payload on expand, so the ingest cap is replaced by a **total-bytes ring budget** (AC7). This is a deliberate weakening of a per-entry cap into a global cap; the memory bound is preserved, but by a different mechanism, so AC7's test is load-bearing.

### Order of work (tests FIRST at every step, per TDD.md)

**Phase A — merge the parent task.** `feat/TASK-20260804-hub-polish` is Gate-5 green (826 tests, Playwright 30/30). Close it out and merge, then branch this task off the updated `main`. Same shape as last time; nothing here starts until that lands.

**Phase B — adapters: observation + caching (`packages/adapters`) — AC4, AC5(data), AC8(data), AC12–AC15.** Lands first because it is the widely-depended package and everything downstream consumes its types.
1. Failing tests: a `round_trip_start` event fires **before** `adapter.complete()` resolves (AC8); `AgentRoundTrip` carries the wire `model` (AC4); `TokenUsage` carries cache-created/cache-read (AC13); `cache_control` lands on the **tools+system prefix and nowhere else** (AC12); local/Ollama requests carry **no** cache field (AC14 — the `max_completion_tokens` failure class); no credential in any emitted record (AC15).
2. Implement: add the start event and the model field at the `runAgentTurn` choke point; add cache fields to `TokenUsage` and parse `cache_creation_input_tokens`/`cache_read_input_tokens` from the Anthropic stream (`message_start` usage) and `cached_tokens` from OpenAI; put one breakpoint on the last system block (caching tools+system together per the render order) **only** on the builder/agent path.
3. Per R2 the honest cache assertion is on a **mocked provider response reporting cache reads**, not on "we sent the field".
   - *Dependents (Gate 5): `server`, `playground`.*

**Phase C — tool timing (`packages/adapters` + `apps/playground`) — AC5.**
4. Failing tests: each tool execution reports its own elapsed time, attributed to the round trip that requested it.
5. Implement: bracket the tool handler (not the LLM call) with `performance.now()`, and attribute results to the requesting round-trip index so the UI can nest them (Q3).

**Phase D — the round-trip surface (`apps/playground`) — AC4–AC9, AC13.**
6. Failing tests: model name rendered; tools nested with per-tool times; `sent`/`received` collapsed by default, expanding to the **complete** payload, each with a byte size in its header; in-flight entries with a live timer (fake timers per R4); cached % shown only when the provider reported caching (AC13's absent-not-zero rule); **AC7's eviction test** — push oversized payloads, observe oldest-entry eviction.
7. Implement: replace the ingest cap with a **total-bytes ring budget** (D2/R1 — this is the load-bearing change), add in-flight entry state, and rebuild the panel around a nested round-trip → tools tree. Memoize per-entry rows so a 100ms tick does not re-render the whole list (R5).

**Phase E — status line & brand (`apps/playground`) — AC1–AC3, AC9–AC11.**
8. Failing tests: starter card opens on card click with a discernible accessible name and keyboard activation, and still does not install (AC1/AC2 — the parent task's outcome tests must stay green); `--text-brand` at 2rem with the narrow token scaled and no header overflow (AC3); rotating copy differs between first-build and edit (AC10, asserted on copy selection, not DOM strings); `prefers-reduced-motion` disables both animation and rotation (AC11).
9. Implement: restructure the starter tile to a single card control, retire the `starter-try` button, drop the brand token to 2rem, and replace the reasoning pill with the rotating status component in both `ChatLog` and the build view.

### Cross-package impact
`adapters` → `server`, `playground` (Phases B/C force both suites). Gate 5 runs `pnpm test` at root, the validator, `pnpm build`, and Playwright. The parent task's baseline to preserve: **826 tests, Playwright 30/30**.

### Risks
- **R1: the ingest-truncation change is the AC14 regression risk.** The parent task's reviewer specifically flagged "60 entries with unbounded per-entry size is unbounded". Removing the per-field cap without a total-bytes budget reintroduces exactly that bug.
- **R2: caching below the minimum silently does nothing.** The floor is model-dependent (512/1024/2048/4096). A test asserting "we sent `cache_control`" proves nothing about whether a cache was created — the honest assertion is on `cache_read_input_tokens` from a mocked provider response.
- **R3: local/Ollama endpoints reject unknown fields.** Same failure class as the parent task's `max_completion_tokens` regression, which broke every local turn. AC14 is the guard.
- **R4: live-timer tests are flake-prone.** Elapsed-time assertions must use fake timers, never wall-clock sleeps.
- **R5: real-time updates re-render the panel per tick.** A naive implementation re-renders the whole round-trip list every 100ms during a 30-minute build.

## Decisions & surprises

- Item 6 ("the audit trail is redundant") targets the surface the **parent task just built** — the step timeline. Recording this because it is a deliberate replacement of recent work, not an oversight.
- Item 5 is not a UI fix: the adapters emit `round_trip` only on completion, so live progress requires a **new event at call start**, which is an adapters change and therefore High tier.

## Session journal (append-only, newest last)

### 2026-08-04 — Jeetu — session (Gate 1)

- Done: Gate 1. Verified every claim against the code before specifying: the panel's current fields, the adapters' completion-only `round_trip` emission, the absence of any `cache_control` anywhere, `TokenUsage`'s two-field shape, and that truncation happens at ingest. Loaded the current Claude API caching guidance rather than working from memory (prefix-match rule, 4-breakpoint cap, model-dependent minimum).
- Done: **Gate 1 and Gate 2.** Interviewed the owner (3 questions); all three recommendations accepted and recorded in D0. Phase plan written (A–E), 15 ACs.
- Interview outcomes: the step timeline's **record survives as nested tools** while only the duplicate pill is replaced; caching is scoped to **builder/agent turns only** (app-frame envelopes excluded as below the cacheable minimum); tools **nest under the round trip that requested them**, timed around the tool handler.
- State: **awaiting plan approval — no implementation code written.** Branch not yet created (Phase A must merge the parent task first).
- Next step: on approval, Phase A (merge `feat/TASK-20260804-hub-polish`), then B→E test-first. High tier also wants a fresh-context review of this plan before implementation.
- Open questions: none blocking.

### 2026-08-04 — Jeetu — session (Gate 3 start)

- **Plan approved** by the owner; instruction: go through all phases.
- **Phase A is a no-op — already done outside this task.** `feat/TASK-20260804-hub-polish` merged as `8e0a792` (PR #3) before this session started, so `main` already carries the LLM inspector, `ThinkPanel` and starter flow this task builds on. D1's "branch off the parent branch" is therefore stale: branch cut off `main` instead. No work lost; recording it because the plan text still describes the pre-merge world.
- Baseline verified on `main` before branching: clean tree, in sync with `origin/main`, **826 tests green** (protocol 103, knowledge 61, runner 91, adapters 74, db 168, sdk 35, server 104, playground 190) — matches the parent task's recorded baseline exactly.
- Branch created: `feat/TASK-20260804-observability-caching`.
- Next step: Phase B (adapters) test-first.

### 2026-08-04 — Jeetu — session (Phases B–E)

- Done: **Phases B, C, D and E, all test-first.** Suite **826 → 890**; build 9/9; Playwright **30/30**.
  - **B (adapters)** — `round_trip_start` fires before `complete()` resolves (asserted with a deferred the test releases by hand, not event ordering); wire `model` on the result; `cacheCreationTokens`/`cacheReadTokens` on `TokenUsage`; one `cache_control` breakpoint on the last system block. adapters 74 → 85.
  - **C (tool timing)** — `roundTripIndex` + `durationMs` on tool events, bracketing the handler. 85 → 89.
  - **D (surface)** — the AC7 swap, in-flight entries, nested tools, whole payloads with byte sizes, cached %. playground 190 → 223.
  - **E (status line & brand)** — single card control, brand token −20%, rotating StatusLine replacing pill + timeline. 223 → 239.
- **Decision — cache opt-in is per adapter, not automatic.** AC12 scopes caching to builder/agent turns (D0/Q2), and the adapter cannot tell which turn it is serving. So `cache` is an option the caller sets, and it is additionally refused for any non-Anthropic `baseUrl` even when set — a local endpoint rejects unknown fields, the `max_completion_tokens` failure class from the parent task.
- **Surprise — removing ingest truncation removed two things it was doing silently.** It bounded the redaction regexes' work, and it dropped credentials buried past the cap. Both are now explicit: redaction runs over full payloads, with a test for a key in the tail of a 50 KB prompt.
- **R4 in practice** — `runAgentTurn` measures with `performance.now()`, which Vitest fake timers do **not** drive. Advancing timers left the assertions reading a real ~0.05 ms elapsed. Fixed by stubbing the clock so the elapsed assertions stay exact rather than degrading to `toBeGreaterThan(0)` — the vacuous-test trap `lessons.md` already records.
- **Seam rename** — `onRoundTrip(trip)` → `onLlmEvent(event)` across builder, transport, `useBuilderChat` and both views. The surface needs starts and tool events, not just completions; renamed rather than widened in place so each call site states the new contract.
- **Tests changed rather than deleted, in four places, each recorded:** the `agent-turn` tool-event assertion gained the two new fields (`durationMs` via `expect.any(Number)`, everything else still strict); `brandAssets`' 2.5rem pin became "sized via a token" with the value assertion moving to the AC3 test; the two ChatLog step-timeline render tests were rewritten to assert the *replacement* surface; the app-frame C1 test was **widened** to check the whole event stream rather than only completed trips.
- **Playwright** — 3 failures at first, all from the AC1 change: the E2E matches the starter control by accessible name (`/open chess/i`), which the card's blurb text did not provide. Fixed in the component with an explicit `aria-label`, which is the right answer for screen readers too. A later 1-failure run was a cold-build flake (43 s vs 23 s wall-clock); green 30/30 on a warm build, and `main` also gives 30/30.
- **Gap found and closed while journaling — AC12's server half.** The plan scopes caching to "direct mode **and the hub's `/invoke` path**" and the header lists `apps/server` as touched, but Phases B–E only wired the client: `apps/server/src/adapter.ts` still built its Anthropic adapter with no cache opt-in. That is the *highest-value* caching path in the product — every hub user's builder turns share one large system prompt and repeat many times per build. Fixed with `cache: true` on the anthropic branch plus an injectable fetch so the request body can be asserted without a network call; the openai branch deliberately stays out (AC14). server 104 → 107, suite → **893**.
- State: **all five phases complete plus AC12's server half. Gate 5 green: 893 tests, build 9/9, Playwright 30/30.** Not yet merged.
- Next step: Gate 5 review (High tier — the plan's fresh-context review has **not** been run; it needs an explicit ask), then PR and Gate 6.
- Open questions: none blocking.

### 2026-08-05 — Jeetu — session (Gate 5 fresh-context review)

- Done: the High-tier **fresh-context review** the plan asked for. Three reviewers (adapters+caching, inspector memory bound, UI+seam), each told to falsify rather than confirm and to prove findings by writing a failing test or showing a test survives reverted implementation. **Six confirmed defects, all fixed.** Suite **893 → 906**; build 9/9; Playwright 30/30.
- **The two caching defects were mirror images of one root cause: I decided caching per ADAPTER when it is per TURN.** The server builds one adapter serving both `/invoke` paths, so `cache: true` on it hit the app-frame path that D0/Q2 explicitly excludes — a 1.25× write premium on every Chess move forever, for a prefix below the cacheable minimum that is never read. Meanwhile direct mode was never wired at all. `cache` now lives on `AdapterRequest`, and the route derives it from `withTools`, which already discriminates the two paths exactly.
- **My journal's earlier gap analysis was inverted.** The 2026-08-04 entry recorded "AC12's server half" as the gap. The server half was the one that *was* done (via the adapter default, over-broadly); the **client** half was missing. Correcting the record here rather than editing the earlier entry, which is append-only.
- **AC7 did not actually hold — three ways.** `entryBytes` omitted `toolNames` and `message` (60 entries × 20 long tool names reported 360 bytes while retaining ~60 MB); and the "always keep the newest" guard exempted entries that keep *growing* after admission, so 25 `artifact_write` results reached 25 MB on one entry — and the loop drained all prior history chasing a target it could never reach. That is the parent reviewer's "unbounded per-entry size" finding, reintroduced through a different door. An entry too big to fit alone now has its payloads **elided**, keeping the record without the bytes.
- **One of my own tests was a proof of the bug.** `keeps at least the newest entry even when it alone exceeds the budget` asserted `system).toBe(monster)` — "still whole (AC6)" — which is exactly the unbounded retention AC7 forbids. Rewritten to assert elision plus the surviving record.
- **The status line never stopped.** `steps` is cleared at turn start but never at turn end; the old timeline rendered that lingering array as *completed* steps (correct), the new surface renders "in flight" (a lie), so after any build the user saw it rotating forever. Now keyed on `busy`. My test passed a hand-built `steps` array and never exercised the end-of-turn transition — the gap that let it through.
- Also fixed, **pre-existing on `main`** and in scope: the redaction callback spliced a match *offset* into output for all seven group-less patterns (`String.replace` calls them as `(match, offset, string)`), so `key sk-ant-…` rendered as `key 4«redacted»`. No credential leaked — the payload was corrupted. The existing tests only asserted the secret was absent.
- **Lesson for `lessons.md` at Gate 6:** *"a test that asserts at the wrong altitude proves nothing about scope."* Every AC12 test asserted at the adapter and none at the call site deciding which turns get cached — which is why two opposite scope bugs both passed. Likewise the AC7 tests only exercised growth via `system` on completed round trips, so every other growth path escaped.
- Reviewers confirmed sound, having tried to break them: AC8 ordering on the error/max-iteration/abort paths, breakpoint placement, C1 at every new seam, R5 memoization, AC13 cached-% math, AC11 reduced-motion, and no ReDoS from unbounded redaction input (5 MB redacts in 20 ms).
- State: **Gate 5 green after review fixes.** 906 tests, build 9/9, Playwright 30/30.
- Next step: PR, merge, Gate 6.

### 2026-08-05 — Jeetu — session (Gate 6 — close)

- Done: **merged.** PR [#4](https://github.com/snugprotocol/snug/pull/4) → `main` as `db12419`; branch deleted. Re-verified on merged `main`: **906 tests** (protocol 103 · knowledge 61 · runner 91 · adapters 90 · db 168 · sdk 35 · server 110 · playground 248), build 9/9, Playwright 30/30.
- Done: **Gate 6.** Three lessons written to `docs/lessons.md` (test altitude · re-deriving a bound · re-checking signals when a surface changes meaning). **ADR-0012** records the per-turn caching contract — written because the review proved this is easy to get wrong in *both* directions, so the constraint needs to outlive the task file. Docs drift fixed in `architecture.md` (status line + ADR ref), `code-map.md` (six rows: adapter events + per-turn cache, server caching scope, the `onLlmEvent` seam rename, the inspector's new bound, the retired step timeline, and per-package test counts), `next-steps.md` (shipped entry + three dated follow-ups), `decisions/README.md` (ADR index).
- **No spec-sync.** `packages/protocol` is byte-unchanged (`git diff 8e0a792..HEAD -- packages/protocol` is empty), so C3 is not engaged: `AgentRoundTrip`/`TokenUsage`/`AdapterRequest.cache` are adapter-level types consumed in-process and never cross the app-iframe wire. No `docs/spec-changelog.md` entry.
- **Root-file sync rule honored** — only `docs/` was edited; `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` untouched and their shared bodies still byte-identical.
- Carried forward as dated backlog rather than fixed here (each is out of this task's scope and none is reachable today): `supportsCaching()` should be `===` not `endsWith` before any `baseUrl` config surface exists · OpenAI's always-present `cached_tokens: 0` renders "0% cached" where Anthropic renders nothing — both correct under absent-vs-zero, but inconsistent side by side · AC6's elision exception is invisible in the UI beyond the marker.
- State: **closed.** Merged, verified green on `main`, task file moved to `docs/tasks/done/`.
- Next step: none for this task. Queue is `docs/next-steps.md`.
- Open questions: none.
