# TASK-20260803-hub-ops: long-run builds, build observability, app delete, LLM-free apps

- **Status**: in-progress — **ALL PHASES (0–6) done; ADR-0011 accepted; Gate 5 COMPLETE** (tests + validator + Playwright + independent adversarial review, whose findings are fixed). Remaining: Gate 6 (`/close-session`) and merge.
- **Owner**: Jeetu
- **Risk tier**: **high** (auto-escalated: `packages/adapters` is the C1 LLM choke point; `packages/db` gains a destructive cascade delete; `apps/server` request/timeout config)
- **Branch**: `feat/TASK-20260803-hub-ops`
- **Packages touched**: `packages/adapters`, `packages/db`, `packages/knowledge`, `apps/server`, `apps/playground`, `examples/`
- **Spec impact**: **none** — deliberately no `packages/protocol` change (see D1). No schema v3, no SPEC_SYNC, no spec-changelog entry.
- **Related**: ADR-0004 (prompt store), ADR-0007/0010 (user DB, native app schemas), ADR-0011 (new, drafted here), `docs/lessons.md` 2026-08-02 (empty-env foot-gun), 2026-08-03 (pinned-row deletes)

## Spec (what & why)

Six items from one session, sharing a theme: the hub can build and host *living* apps, but long builds die silently, the user cannot see what the model is doing, installed apps cannot be removed, and both the knowledge base and the starter examples assume every app talks to an LLM.

Research established that two of the six were **not** defects:

- **Google SSO (item 1) is fully implemented and needs configuration, not code.** `sign in with google` exists at `SettingsView.tsx:237` and `App.tsx:124`, gated on `GET /auth/me` returning 401. That route is only registered when the server boots with `SNUG_AUTH=google` (`app.ts:95-114`); otherwise it 404s, the client's four-state machine (`state/auth.ts:14-18`) resolves to `'unavailable'`, and both surfaces hide. All required vars sit commented out in `apps/server/.env.example:52-72`. **No code change — documentation + a render-condition test only** (the state machine is tested; the JSX branch that consumes it is not).
- **The DDL prompt structure (item 4) has not deviated.** DDL guidance lives in the store at `prompts/tools/schema-apply.md` (layer `tool`) and `knowledge-base/app-authoring/40-persistence-and-db.md`; the naming rule is single-sourced from `APP_OBJECT_NAME_RULE` (`packages/protocol/src/userdb-schema.ts:73`) and injected via `packages/knowledge/src/render.ts:36`. No DDL prose is hardcoded in app-builder code. **No change required** — a centralization-lint assertion is added to keep it that way.

The remaining four are real work.

**The long-build failure (item 2) is not a timeout.** There is no timeout anywhere in the LLM path — no `AbortSignal.timeout`, no Fastify `requestTimeout`, no vite `proxyTimeout`. The actual ceiling is `DEFAULT_MAX_ITERATIONS = 6` (`packages/adapters/src/agent-turn.ts:41`), never overridden by either caller (`apps/server/src/app.ts:79-90`, `apps/playground/src/agent/builder.ts:195`). A data-backed build (KB consult → `schema_apply` → `artifact_write` → `app_doc_write` → sign-off) reaches 4-6 iterations and a build that consults the KB twice hits the cap and hard-fails with a non-retryable `HOST_ERROR`. Compounding it, both adapters discard accumulated text on a dropped stream (`anthropic.ts:157`, `openai.ts:131`), so a build that dies at minute 28 loses everything it had written.

**Acceptance criteria** (each becomes at least one test):

*Long-run correctness (item 2a)*
1. A builder turn requiring 12 sequential tool round-trips completes successfully (mock adapter, scripted 12-iteration script) — proving the iteration ceiling no longer terminates a legitimate long build.
2. Exceeding the new ceiling still fails closed with a clear, non-silent terminal error naming the limit (no infinite loop).
3. When a provider stream ends without its terminal event, the accumulated partial text is returned to the caller with the error instead of being discarded; `useBuilderChat` renders that partial text plus a retryable error rather than an empty bubble.
4. The reference server sets explicit request/connection/keep-alive lifetimes admitting a ≥30-minute streaming response; a test asserts the configured values (Node's implicit `requestTimeout` default of 300 000 ms is overridden, not inherited).
5. The dev proxy is configured with disabled timeouts so a long build survives `vite dev` (config assertion).

*Token limits (item 2b)*
6. The Anthropic adapter requests 128K max output tokens by default and sends the beta header required for it; a test asserts both appear on the wire.
7. The OpenAI adapter sends an explicit max-output-token field (absent entirely today) and honours an override.
8. Both limits are overridable per-call and the override reaches the wire.

*Build progress UI (item 2c)*
9. The builder chat renders an ordered, live **step timeline** for a turn (KB consulted → schema applied → app file written → docs updated → done), replacing the single last-write-wins `activity` pill — asserted at the component level, which today has no test at all.
10. Steps show completion, not just start: a `tool_result` marks its step done (today `tool_result` is received and ignored, `builder.ts:204-208`).
11. Subscription mode emits progress too — new SSE event types carry tool activity from `/invoke`, which today emits only `delta|artifact|done|error` and therefore shows `'it's thinking…'` and nothing else for an entire build.
12. Streaming stays live throughout: deltas continue to render into the message while steps advance.

*LLM round-trip inspector (item 2d)*
13. A **new** inspector surface shows per-round-trip LLM request and response data (system/messages/tool defs sent, text/tool-calls/stop-reason returned, token usage, wall-clock duration), captured at the `runAgentTurn` choke point.
14. It is **in-memory only** — a test asserts nothing from it is written to the user DB (no new table, no growth in `snug_chat_messages.meta`), and that it is bounded (ring buffer) so a 30-minute build cannot exhaust memory.
15. The existing **structural-only bridge inspector keeps its guarantee** — `inspector.test.ts`'s marker assertions still pass unchanged, and the new surface is a separate sibling, not an extension of `inspector.ts` (C1-adjacent negative test: the new surface must never render a BYOK key even though it renders request bodies).

*App delete with cascade (item 3)*
16. Deleting an installed app removes, in ONE transaction: its `app_<token>__*` native tables, and its rows in `snug_app_schemas`, `snug_app_migrations`, `snug_app_docs`, `snug_app_versions`, `snug_chat_threads`, and `snug_chat_messages` (via `thread_id`), then `snug_apps`.
17. The delete ignores `pinned` — the factory-pinned version (`snug_app_versions.pinned`) and pinned bootstrap chat message (`snug_chat_messages.pinned`) are removed too. Existing retention helpers (`pruneChatMessages`, version retention) must NOT be reused, as both refuse pinned rows.
18. No orphans remain: a post-delete query across all six `app_id` tables plus the `thread_id` join returns zero rows.
19. The freed `install_source` can be reinstalled afterwards (the partial unique index no longer collides).
20. The deleted app does not resurrect after a driver close/flush cycle — the in-memory `namespaceByFile` / `lastSavedHash` caches and the materialized runtime copy are invalidated, or `writeBack` re-creates the rest tables from the still-open runtime DB.
21. A failure mid-delete rolls back completely (no partial cascade), following `writeBack`'s `BEGIN IMMEDIATE`/`ROLLBACK` pattern.
22. The hub UI offers per-app delete with an **inline** two-step confirm (no `window.confirm` — forbidden by the design contract), the tile is restructured so the action is not nested inside the navigation `<Link>`, and a double-click cannot double-delete (latch idiom from `HubView.tsx:32`).
23. The delete marks the DB dirty and flushes so the change reaches the exported bytes and the sync hash gate.

*LLM-free apps (items 5 + 6)*
24. The knowledge base no longer defines an app as one that "thinks through the host's agent": the contract admits apps that never call the LLM, and the catalog gains an autonomous/local-only archetype with explicit guidance on deciding per app whether a turn needs the model (chess = every move; arcade game = never).
25. The flying-pig example is replaced with the attached game, **ported to the contract**: gameplay, art, audio, and feel preserved verbatim; the raw `postMessage`/`cheo-app-announce` bridge replaced with the byte-identical embedded hooks block; `localStorage` high score moved to `usePersistedState` (it silently never persists in a null-origin iframe).
26. `examples/validate.test.mjs` passes unchanged — the validator is not relaxed.
27. A test proves an app that never calls `sendMessage` runs correctly end-to-end (announce → host-ready → play → persist), so "LLM-free" is a supported runtime path and not merely tolerated.

**Out of scope**
- Any `packages/protocol` change — no schema v3, no `usesAgent` column, no spec push (D1).
- Persisting audit trails or inspector data to the user DB (explicitly ruled out by the owner).
- `packages/auth` (the v1.1 credential broker) — untouched; hub login is separate.
- Retry/resume of a failed long build (partial-text preservation only, no auto-resume).
- Subscription-mode twins for `schema_apply`/`app_doc_write` (already queued in next-steps; item 2c only adds *progress* events server-side, not new tools).
- Bulk delete / trash / undo — single-app delete with inline confirm only.
- Prompt-caching or cost accounting beyond displaying token usage in the inspector.

## Plan

### D1 — Decisions taken up front
- **No protocol change.** Delete is a hand-written transaction; inspector data is in-memory. This keeps the task off the spec-sync path entirely and avoids a schema v3 migration for existing user files.
- **Two inspectors, not one.** `inspector.ts` (structural, value-blind, marker-tested) is untouched. The LLM inspector is a new sibling rail tab with its own module and its own tests. Rationale: the structural inspector's no-payload-leak invariant is a deliberate privacy guarantee (`inspector.ts:1-7`); extending it to show prompt bodies would invert its central rule.
- **ADR-0011** records the LLM-optional app doctrine (item 6) — it changes what "a Snug app" *means*, which is exactly ADR-shaped.

### Order of work (tests FIRST at every step, per TDD.md)

**Phase 0 — SSO documentation + render test (item 1, no behavior change)**
1. Failing component test: identity chip / AccountCard render the Google button when auth is `anonymous`, and hide it when `unavailable`.
2. `docs/runbooks/` entry: enabling Google SSO locally (exact vars, `dev:local`, the `127.0.0.1:8787/auth/callback` redirect-URI gotcha).

**Phase 1 — adapters: long-run + tokens + capture (`packages/adapters`)**
3. Failing tests: 12-iteration mock build (AC1); ceiling still fails closed (AC2); partial text preserved on drop (AC3); 128K + beta header on the wire (AC6); OpenAI max-output field (AC7); overrides reach the wire (AC8).
4. Implement: raise/curve the iteration ceiling and thread it from both callers; return accumulated text alongside `streamDroppedResult`; parse `message_start`/`message_delta` usage (today explicitly discarded at `anthropic.ts:152`) and the OpenAI `usage` object; add `max_completion_tokens` + option to the OpenAI adapter.
5. Add a per-round-trip observation event to `runAgentTurn` (`{type:'round_trip', index, request, result, usage, startedAt, endedAt}`) with `performance.now()` bracketing around `adapter.complete()`. This is the single capture point for AC13.
   - *Dependents (Gate 5): `runner`, `server`, `playground`.*

**Phase 2 — server: lifetimes + progress events (`apps/server`)**
6. Failing tests: configured timeouts admit a ≥30-min response (AC4); new SSE progress events emitted for tool activity (AC11).
7. Implement Fastify `connectionTimeout`/`requestTimeout`/`keepAliveTimeout`; pass `onEvent` into `runAgentTurn` (today omitted at `invoke.ts:173-185`) and forward as new SSE event types. Keep the parser's forward-compat tolerance — unknown events are already skipped (`sse.ts:54`), so older clients are unaffected.
8. Vite proxy timeouts (AC5).

**Phase 3 — playground: step timeline + LLM inspector (`apps/playground`)**
9. Failing tests: step timeline ordering + completion (AC9, AC10); streaming continues during steps (AC12); LLM inspector content (AC13); in-memory-only + bounded (AC14); BYOK key never rendered (AC15).
10. Replace the single `activity: string` with a `steps: BuildStep[]` model in `useBuilderChat`; render a timeline in `ChatLog.tsx` (which has no component test today — add one).
11. New `llmInspector.ts` + panel as a sibling rail tab; ring-buffered; fed by the new `round_trip` event through a new `BuildHandlers` callback.

**Phase 4 — db: cascade delete (`packages/db`)**
12. Failing tests: full cascade (AC16); pinned rows removed (AC17); zero orphans (AC18); install source reusable (AC19); no resurrection after close/flush (AC20); rollback on failure (AC21); dirty+flush (AC23).
13. Implement `deleteApp(appId)` on `UserDb`: `BEGIN IMMEDIATE` → drop `restTablesFor(appDataToken(appId))` → delete the six `app_id` tables (unconditionally, ignoring `pinned`) → chat messages by `thread_id` → `snug_apps` → invalidate `namespaceByFile`/`lastSavedHash` for the namespace and close the inner materialized driver → `markDirty()` → commit, with `ROLLBACK` on throw.
    - *Dependents (Gate 5): `sdk`, `playground`.*
14. Add `delete` to `LibraryStore` (`apps/playground/src/state/library.ts`).

**Phase 5 — hub UI delete (`apps/playground`)**
15. Failing tests: inline confirm two-step, no `window.confirm`, double-click latched (AC22).
16. Restructure the `HubView` tile from "Link wrapping Card" to "Card containing Link + action"; `danger` Button variant already exists (`ui/Button.tsx:4`); follow the `VersionsPanel.tsx:83-92` callout pattern for the confirm.

**Phase 6 — knowledge + examples (`packages/knowledge`, `examples/`)**
17. Failing tests: KB no longer asserts agent-dependence; new archetype present; centralization lint still green (item 4 guard).
18. Rewrite `10-overview-and-contract.md` opening and add the autonomous archetype to `50-app-catalog.md`. Regenerate `src/generated/content.ts`.
19. Port the attached pig game to the contract; `node --test examples/validate.test.mjs` green unchanged (AC25, AC26); LLM-free runtime test (AC27).
20. Draft **ADR-0011** (LLM-optional apps).

### Cross-package impact
`adapters` → `server`, `playground` (Phase 1 forces both suites). `db` → `sdk`, `playground`. `knowledge` → `server`, `playground`. Per the dependency graph, Phase 1 and Phase 4 both require running dependents; given the breadth, **Gate 5 runs `pnpm test` at root** plus `node --test examples/validate.test.mjs` and the Playwright suite.

### Risks
- **R1 (highest): delete resurrection.** The materializer's `writeBack` re-creates rest tables from the still-open runtime copy on flush. Cache invalidation is the crux of AC20 — modelled on `importUserDb`'s existing teardown (`userdb.ts:1281-1285`).
- **R2: no foreign keys exist and `PRAGMA foreign_keys` is never set**, so "cascade" is entirely hand-written; a missed table means silent orphans. AC18 is the guard.
- **R3: raising max output tokens raises cost per call**; the ceiling change multiplies worst-case spend per build. Both are defaults — surfaced in the runbook.
- **R4: 128K output on Anthropic needs a beta header**; without it the request is rejected or silently clamped. AC6 asserts the wire.
- **R5: the pig port must not drift the hooks block** — it is byte-compare-locked against `packages/sdk/embedded/snug-hooks.js` (lesson 2026-07-31). Copy, never retype.

## Decisions & surprises

- Item 1 needed no code and item 4 needed no change — both were verified against the code rather than taken at face value.
- The reported "timeout" does not exist; the real ceiling was an iteration cap. Recording this because the symptom (a build that stops with nothing rendered) pointed convincingly at a timeout.
- Subscription mode ships only 2 of the 4 tools server-side, so its builds are structurally weaker than BYOK builds — noted, out of scope, already queued in next-steps.

## Session journal (append-only, newest last)

### 2026-08-03 — Jeetu — session
- Done: Gate 1-2. Read PROCESS/TDD/architecture/code-map/lessons/ADRs and the actual code across all six items (four parallel investigations). Interviewed owner: pig ported to contract, KB doctrine + ADR, all four item-2 sub-scopes in, High tier without protocol change. Branch `feat/TASK-20260803-hub-ops` created off `main`. Task file written with 27 ACs.
- State: **awaiting plan approval — no implementation code written.**
- Next step: on approval, Phase 0 → Phase 6 in order, tests first at each step. High tier also requires a fresh-context AI review of this plan before implementation.
- Open questions: none blocking. Iteration-ceiling value and the exact server timeout numbers are proposed at implementation time as part of Phase 1/2 tests.

### 2026-08-03 — Jeetu — session (plan approved; Phases 0–2 implemented)
- Done: **plan approved** by owner, with one explicit confirmation: *"Delete must also delete pinned, the factory version & bootstrap message"* (this is AC17 as written — no change to the plan). Implemented Phases 0, 1 and 2 test-first; each committed with the full suite green.
- State: 4 commits on `feat/TASK-20260803-hub-ops`, working tree clean, `pnpm test` = **19/19 tasks, 666 tests**.
- Next step: **Phase 3** (playground step timeline + LLM round-trip inspector). See the handoff block below.
- Open questions: none blocking.

### 2026-08-03 — Jeetu — session (Phase 3 implemented)

- Done: **Phase 3** (AC9–AC15) test-first. 19 new tests, all green; suite 666 → **685** (playground 73 → 92).
  - **Step timeline (AC9, AC10, AC12).** `activity: string | undefined` (one last-write-wins slot) is now backed by `steps: BuildStepView[]` — ordered, per-turn, each with its own `done` flag. `onStep` added to `BuildHandlers` as the seam; **both** modes feed it: direct mode from `tool_call`/`tool_result` (the `tool_result` branch that was previously received-and-ignored is now what marks a step done), subscription mode from Phase 2's `step` SSE event. `ChatLog` renders the timeline and keeps the old pill as the pre-first-tool fallback.
  - **LLM inspector (AC13–15).** New sibling module `run/llmInspector.ts` (pure reducer, mirroring `inspectorReduce`) + `run/LlmInspectorPanel.tsx` + a new `llm` rail tab. `run/inspector.ts` and `__tests__/inspector.test.ts` are **byte-untouched** — verified by an empty `git diff` on both, which is AC15's real assertion.
- Surprises / decisions worth keeping:
  - **`AgentRoundTrip` and `TokenUsage` were never exported from the adapters barrel** in Phase 1 — the types existed but were unreachable from the playground. Added to `packages/adapters/src/index.ts`. Anything consuming Phase 1's observation contract needs this.
  - **Redaction happens on the way IN, not at render.** An un-redacted key is never stored in inspector state, so the AC15 marker test holds no matter what a future panel chooses to render. This is the inverse of the structural inspector's approach (which never captures values at all) and is the reason the two modules must stay separate.
  - **A tool can legitimately run twice in one turn** (two KB consults — the exact case that used to blow the old 6-iteration ceiling). `applyStep` therefore completes the *newest open* step for a tool, not the first match, and the step key includes the index.
  - `findLastIndex` is ES2023; the playground lib target is ES2022. Hand-rolled the reverse scan rather than move a project-wide target for one call.
  - Test-harness trap (cost ~2 debug cycles): `mockResolvedValue(sseResponse(...))` shares ONE `Response` across calls, and a `ReadableStream` body is single-use — the second turn gets an already-drained stream and silently sees zero events. Multi-turn SSE tests must use `mockImplementation` to build a fresh Response per call. Candidate for `docs/lessons.md` at Gate 6.
  - `llmInspectorPersistence.test.tsx` passed on first run *by design*: it is a guard (byte-level export assertion that no round-trip data reaches the user DB) — it exists to fail if a later phase starts persisting. Re-verified green after implementation.
- State: 5 commits + this one on `feat/TASK-20260803-hub-ops`; `pnpm test` 19/19 tasks / **685 tests**; `pnpm build` 9/9 clean. (No root `lint` task exists — turbo reports "No tasks were executed"; typecheck rides on `build`.)
- Next step: **Phase 4** — `packages/db` cascade delete (AC16–21, AC23). Highest-risk item in the task; see the handoff notes below, especially R1 (resurrection via `writeBack`).
- Open questions: none blocking.

### 2026-08-03 — Jeetu — session (Phase 4 implemented)

- Done: **Phase 4** (AC16–21, AC23) test-first, plus plan step 14. 17 new tests; suite 685 → **702** (db 145 → 160, playground 92 → 94).
  - `UserDb.deleteApp(appId)`: one `BEGIN IMMEDIATE` transaction — drop `app_<token>__*`, delete chat messages via the `thread_id` subquery, then threads/docs/versions/migrations/schemas, then the app row last. Unconditional on `pinned`. `ROLLBACK` on any throw.
  - New `SnugDbDriver.evict(namespace)`: cancels the debounce, **discards** pending writes, closes the handle, drops the cache entry. Deliberately does not persist — persisting is the resurrection.
  - `LibraryStore.delete` added (plan step 14).
- **R1 resolved, and the guard is redundant on purpose.** Mutation-tested all three ways: eviction alone stops the resurrection, cache invalidation (`namespaceByFile`/`lastSavedHash`) alone stops it, and the app's data tables only come back when **both** are removed. Kept both and said so in a comment, because they fail in different directions. If someone later "cleans up" one of them, the tests stay green and the hazard silently returns — that is the trap this note exists to prevent.
- Surprises worth keeping:
  - **My first AC20 test was vacuous.** It deleted a namespace that was already clean, and `persist` skips clean states — so it passed even with eviction AND cache invalidation both disabled. The test now writes without flushing first, so a pending write-back is genuinely outstanding at delete time. With both guards off it fails with "app data tables came back after flush" (2 tables rebuilt). **Any future test of the materializer must dirty the namespace first or it proves nothing.**
  - Same lesson hit the driver tests twice: an assertion behind `backend.list?.()` never ran (`MemoryBackend` has no `list()` — it exposes `files` directly), and a debounce-only assertion passed for the wrong reason because `state.db.export()` on a closed handle throws into a swallowed `.catch`. Both now assert through an explicit post-evict `flush()`.
  - **Deleted data survived in the exported bytes.** Dropping rows only marks pages free; the app id, chat and docs were still readable in `exportUserDb({includeSecrets: true})`, which skips the VACUUM that the secret-stripping path does. `deleteApp` now VACUUMs after the transaction (SQLite forbids it inside one) so every export path benefits. This was caught by AC23, not designed in.
  - Rejected a `failAfterFirstStepForTests` option on the public API for the AC21 rollback test. Injected a real SQLite failure instead — a `BEFORE DELETE` trigger with `RAISE(ABORT)` on `snug_apps`, installed by round-tripping the file through `importUserDb` (the pattern `userdb-v2.test.ts` already uses). Verified against sql.js that ROLLBACK restores even already-DROPped tables.
- State: 6 commits + this one; `pnpm test` 19/19 tasks / **702 tests**; `pnpm build` 9/9 clean.
- Next step: **Phase 5** — hub UI delete (AC22): inline two-step confirm, no `window.confirm`, tile restructured out of the `<Link>`, double-click latched.
- Open questions: none blocking.

### 2026-08-03 — Jeetu — session (Phase 5 implemented)

- Done: **Phase 5** (AC22) test-first. 8 new tests; suite 702 → **710** (playground 94 → 102).
  - `HubView` tile restructured from `<Link>`-wrapping-`Card` to **`Card` containing `Link` + action**, so the delete button is a sibling of the navigation rather than nested inside an `<a>` (a button inside the link navigates into the app on click). A test asserts `button.closest('a') === null` so the nesting cannot silently return.
  - Inline two-step confirm ("delete" → "delete for good? / keep"), styled on the `.factory-reset` callout. **No `window.confirm`** — a test spies on it and asserts zero calls.
  - Double-click latched with a **`useRef`, not the `deleting` state**: two clicks in the same tick both read the pre-render state value and would each fire a delete. Mutation-tested — removing the latch makes `deleteApp` fire twice.
  - `delete` is revealed on hover/focus-within, and forced visible under `@media (hover: none)` so it is reachable on touch.
- Surprises:
  - **A test that passed in isolation failed in the full suite** — the wrong app survived. `listApps` orders by `updated_at DESC, app_id`, and two saves in the same millisecond tie-break on a **random uuid**, so tile order is not deterministic. My test had indexed `tiles[1]`, i.e. it was passing by luck. Now finds the tile by name. **Never index into a tile/app list in a test** — the order is only stable when the timestamps differ.
  - `.app-tile` is shared with the starter tiles, so a bare `.app-tile` selector matched 4 elements, not 1. Installed tiles now carry `data-testid="installed-tile"`.
- State: 7 commits + this one; `pnpm test` 19/19 tasks / **710 tests**; `pnpm build` 9/9 clean. Playground suite run 3× to confirm the ordering flake is gone.
- Next step: **Phase 6** — knowledge + examples (AC24–27) + accept ADR-0011. Largest remaining piece: KB doctrine rewrite, the autonomous archetype, regenerating `content.ts`, and porting the pig game to the contract (hooks block **copied, never retyped**).
- Open questions: none blocking.

### 2026-08-03 — Jeetu — session (Phase 6 implemented — all phases complete)

- Done: **Phase 6** (AC24–27) test-first, **ADR-0011 accepted**. 8 new tests; suite 710 → **718** (knowledge 55 → 61, sdk 33 → 35).
  - **AC24 doctrine.** The opening definition no longer makes agent use constitutive: an app is defined by the contract it honours (one file, sandbox, host-brokered storage); reaching the agent is a capability it MAY use. The Runtime Loop now says steps 1-2 are the whole loop for a local-only app and 3-5 happen only on `sendMessage`. Catalog gains an **Autonomous / local-only** row with Agent's role **None**, a "Deciding Whether a Turn Needs the Model" section (chess = every move → quiz = per batch → tracker = on demand → arcade = never), and per-type guidance. `content.ts` regenerated.
  - **AC25/26 pig port.** CSS art **byte-identical** to the source (verified programmatically), every gameplay symbol count matches (`AudioEngine` 13/13, `randBetween` 6/6, …). Hooks block **copied** from the already-validated example, never retyped. `localStorage` → `usePersistedState`, `cheo-app-announce` → `useSnugApp`, `// 5. RESPONSE SCHEMA` banner added (set to `null`, with a comment saying why, rather than faking a schema). `node --test examples/validate.test.mjs` passes **18/18, validator unchanged**.
  - **AC27.** LLM-free runtime test on the existing sdk jsdom harness: announce → host-ready → play → persist → reload, asserting `transportCalls` stays `[]`. Mutation-tested — adding one stray `sendMessage` fails it.
- Surprises:
  - **The doctrine phrase lived in TWO files**, not one: the KB overview *and* `prompts/skills/builder-preamble.md`. The test asserts on both. My first preamble rewrite still contained the banned phrase mid-sentence and the test caught it — worth noting that the assertion is on the phrase, not the file.
  - **The validator requires announce fields as inline LITERALS.** The source game passed `displayName: APP_DISPLAY_NAME` constants, which fails `announce metadata is complete`. Inlined the literals and deleted the now-dead constants rather than relaxing the check (AC26 forbids that).
  - Two golden snapshots (skill-prompt assembly, KB heading tree) failed on the doctrine edit — **as designed**. Reviewed both diffs before updating: exactly the two new headings and the one rewritten sentence, nothing else.
  - `isReady`/`theme` were initially destructured but unused. Now gates the first paint, because the high score hydrates through the bridge and rendering earlier flashes a 0 — an LLM-free app still waits for `hostReady`.
  - The ported JSX has no build step, so a validator pass does not prove it compiles. Verified separately with `tsc --jsx preserve --allowJs` (993 lines, zero syntax errors). `@babel/standalone` is CDN-only and not resolvable locally.
- Removed `docs/tasks/active/TASK-20260803-hub-ops-assets/` per the handoff, now that the port has landed.
- State: 8 commits + this one. **Gate 5 green**: `pnpm test` 19/19 tasks / **718 tests**; `node --test examples/validate.test.mjs` 18/18; `pnpm build` 9/9.
- Next step: **remaining Gate 5** — the Playwright suite (`pnpm --filter playground test:e2e`) and, per the high tier, an independent adversarial review before merge. Then Gate 6 (`/close-session`): lessons, doc drift (`architecture.md`, `code-map.md`, `next-steps.md`), and move this file to `done/` on merge. **No spec-changelog entry — `packages/protocol` deliberately untouched.**
- Open questions: none blocking.

### 2026-08-03 — Jeetu — session (Gate 5: adversarial review + fixes)

Two independent fresh-context reviewers (high-tier requirement) audited the db cascade and the C1/inspector/UI surface. **Both found real, merge-blocking defects.** Every finding below was reproduced empirically before being fixed, and each fix has a regression test that was mutation-checked (reverting the fix makes the test fail).

**F1 — HIGH, data resurrection.** An app's iframe does not stop when the app is deleted. Its next db frame hit `noteNamespace`, which unconditionally re-registered the namespace, and the following write-back re-created the app's data tables **plus an orphaned `snug_app_schemas` row with no parent**. The app looked deleted in `listApps()` while its data lived on in the file and every export. Verified: `REST: [app_…__zombie2] APPS: [] SCHEMAS: [<appId>]`. **Fixed** with a `deletedApps` tombstone consulted by `driver.handle` — deletion is terminal; frames for a dead app are refused. My AC18 sweep could never have caught this because it ran with no intervening `handle()`.

**F2 — HIGH, silent data loss.** `evict` deliberately discards the app's in-memory runtime without persisting. If the transaction then rolled back, the app survived **having silently lost its most recent writes** — `ROLLBACK` restores the rest tables, but that delta was never in them. Verified: `UNFLUSHED-PRECIOUS` gone, app still installed. My comment claimed "a failure here aborts before any rows are touched", which reasoned about failures *inside* evict, not about the transaction failing *after* it. **Fixed** by flushing before evicting, so the delta lands in the rest tables where the rollback covers it.

**F3 — MEDIUM.** `markDirty()`/`persistNow()` ran *after* `VACUUM`, so a throwing VACUUM left a committed-but-unpersisted delete while `getApp()` already returned undefined. **Fixed**: `markDirty()` first, VACUUM wrapped in try/catch — a failed space reclaim must never fail a committed delete.

**C1 redaction was narrower than its own comment claimed.** I probed it: `sk-*`/`Bearer`/`AIza` were covered, but GitHub PATs, AWS key ids, Basic auth, `x-api-key:` pairs and bare hex all rendered verbatim. The user's own BYOK key is genuinely safe (it rides in an HTTP header, never in a request body — so C1 proper was never breached), but the app-context block injects the app's own HTML into `system`, so a third-party key a user pasted into chat *would* render. **Fixed**: broader patterns incl. a name/value rule that masks the VALUE and keeps the key NAME readable, plus tests for every shape and every arrival path (tool results, error paths, deeply nested tool inputs).

**Memory bound was nominal.** 60 entries with unbounded per-entry size is unbounded — `system` carries up to 140 KB of app HTML and `messages` is a full conversation snapshot per iteration; with the raised 48-iteration ceiling that is hundreds of MB. Worse, **`'reset'` was never dispatched** — entries accumulated across the whole session, not per turn, and the buffer retained the *largest* entries by construction. **Fixed**: `LLM_INSPECTOR_MAX_FIELD_CHARS` truncation at ingest (which also shrinks the credential surface) and a real `onTurnStart` → `'reset'` dispatch.

**A test of mine was vacuous.** `llmInspectorPersistence.test.tsx` ran in subscription mode, where `onRoundTrip` never fires at all — it asserted that a marker which was never fed to the inspector didn't reach disk, and would have passed against an inspector that wrote everything to the DB. **Fixed** with a test that feeds a round trip through the reducer directly and then checks the DB bytes, localStorage and sessionStorage. (Second time this session a test passed for the wrong reason; both were caught only by asking "would this fail if the code were wrong?")

**Out-of-scope catch, real regression.** Phase 1 made `openaiAdapter` always send `max_completion_tokens: 128_000`, and `localAdapter` delegates straight through to Ollama/llama.cpp — 128K exceeds what a local 7B-class model can emit and some servers reject it with a 400, which would have failed **every local-mode turn**. **Fixed** with `LOCAL_DEFAULT_MAX_TOKENS = 8192` on the local adapter only (the OpenAI wire contract is unchanged), plus two tests.

- State: 9 commits + this one. Suite 718 → **727** (db 160→163, adapters 72→74, playground 102→106). Build 9/9, validator 18/18, **Playwright 26/26**.
- Next step: **Gate 6 (`/close-session`)** — lessons, doc drift (`architecture.md`, `code-map.md`, `next-steps.md`), move this file to `done/` on merge. No spec-changelog entry.
- Open questions: the reviewer noted `importUserDb` clears `lastSavedHash` but not `namespaceByFile` — same cache-coherence family as F1, **pre-existing** and out of this task's scope. Queue it in `next-steps.md` at Gate 6.

---

## HANDOFF — resume here (written 2026-08-03, end of session)

**Branch**: `feat/TASK-20260803-hub-ops` (off `main`), working tree **clean**.

```
8715521 Phase 2 — server: 30-min lifetimes + SSE step events
a5454f8 Phase 1 — adapters: the real long-build fix
381939d Phase 0 — SSO render-condition tests + enable runbook
d4a5bc5 Gate 1-2 — spec, interview, plan, ADR-0011 draft
```

**Baseline to preserve**: `pnpm test` → 19/19 tasks, **727 tests**. Per-package: protocol 103 · knowledge 61 · runner 91 · db **163** · sdk 35 · server 94 · adapters **74** · playground **106**. Plus `node --test examples/validate.test.mjs` 18/18, `pnpm build` 9/9, and Playwright 26/26.

### What is DONE (do not redo)

**Phase 0 — item 1 (SSO). No feature work was needed; it is configuration.**
- The `sign in with google` button already existed at `apps/playground/src/views/SettingsView.tsx:237` and `App.tsx:124`, gated on `GET /auth/me` returning **401**. That route only exists when the server boots with `SNUG_AUTH=google`; otherwise it 404s → `authState` `'unavailable'` → both surfaces hide **by design**.
- Added `apps/playground/src/__tests__/authSurface.test.tsx` (6 tests) and `docs/runbooks/enable-google-sso.md`. Exported `IdentityChip` / `AccountCard` for test (no behavior change).
- **Tell the user**: to see the button, set `SNUG_AUTH=google`, `SNUG_SESSION_SECRET` (≥32 chars), `SNUG_GOOGLE_CLIENT_ID`, `SNUG_GOOGLE_CLIENT_SECRET`, `SNUG_CORS_ORIGIN=http://localhost:5173` in `apps/server/.env.local`, run `pnpm --filter server dev:local` (plain `dev` reads NO env file), and register `http://127.0.0.1:8787/auth/callback` in Google Cloud Console (server origin, **not** the Vite origin).

**Phase 1 — adapters (`packages/adapters`).**
- **The real root cause of "long builds silently drop" was NOT a timeout.** There is no timeout anywhere in the LLM path. It was `DEFAULT_MAX_ITERATIONS = 6` in `agent-turn.ts`, never overridden by either caller. Raised **6 → 48**.
- Partial text preserved on every drop path: `AdapterError.partialText` added in `types.ts`; both adapters populate it; `runAgentTurn` carries text from EARLIER completed iterations onto the error.
- 128K max output on both adapters. **NO beta header** — 128K is built in on current models; the legacy `output-128k-2025-02-19` is a no-op. A test asserts `anthropic-beta` is **absent** so it cannot be re-added. (An earlier draft added that header from memory; it was wrong and was removed after checking the API reference.) OpenAI had no cap at all → added `max_completion_tokens` + `maxTokens` option.
- Token usage parsed from `message_start` / `message_delta` (previously explicitly discarded) → `AdapterResult.usage`.
- **New `round_trip` AgentTurnEvent** — `{type, index, request, response, durationMs}`, emitted per iteration in `agent-turn.ts`. **This is the single capture point Phase 3's inspector consumes.**
- `agent-turn.test.ts`'s exact-event assertion was narrowed to `.filter(e => e.type !== 'round_trip')` — same intent, not weakened.
- New file: `packages/adapters/src/__tests__/long-run.test.ts` (12 tests).

**Phase 2 — server (`apps/server`).**
- `app.ts`: added exported `LONG_RUN_MS = 30 * 60_000`; Fastify now sets `connectionTimeout: 0`, `requestTimeout: 0`, `keepAliveTimeout: LONG_RUN_MS`, plus `app.server.headersTimeout = 0` (Fastify does not surface it). **Why**: Node's defaults are `requestTimeout` 300_000ms (exactly 5 min) and `headersTimeout` 60_000ms — inherited, they tore down long streams with no client-visible error.
- `routes/invoke.ts`: now passes `onEvent` into `runAgentTurn` and emits a new SSE event `step` → `{phase: 'start'|'end', tool: <name>}`. Subscription mode previously had **zero** progress signal.
- **Step events carry tool NAME + phase only** — never inputs/outputs (marker test enforces it). `round_trip` stays server-side, never serialized to the client.
- New file: `apps/server/src/__tests__/long-run.test.ts` (3 tests). Forward-compat verified: the existing SSE parser skips unknown events, so playground stayed green unchanged.

### PHASE 3 — playground step timeline + LLM inspector — ✅ DONE (see the 2026-08-03 Phase 3 journal entry)

Covered **AC9–AC15**. Landed: `steps: BuildStepView[]` in `useBuilderChat` (+ `onStep` on `BuildHandlers`, fed by both modes), the timeline in `ChatLog`, and the new `run/llmInspector.ts` + `run/LlmInspectorPanel.tsx` on a new `llm` rail tab. `run/inspector.ts` untouched.

The notes below are kept because they document the seams as they now stand:

**Key facts already established — don't re-investigate:**
- `useBuilderChat` (`apps/playground/src/agent/useBuilderChat.ts`) currently exposes `activity: string | undefined` — a **single last-write-wins slot**, rendered in exactly ONE place: `apps/playground/src/views/ChatLog.tsx:47-52` (`.reasoning-pill`). Replace with a `steps: BuildStep[]` model.
- `activity` is set at `useBuilderChat.ts:197` (initial), `:238` (artifact save), `:260` (from `onActivity`), cleared at `:229` on first delta and `:308` in `finally`.
- `BuildHandlers` (`apps/playground/src/agent/builder.ts:40-49`) already has `onDelta` / `onArtifact` / `onActivity` / `onKnowledge` — **add `onStep` and `onRoundTrip` here**; this is the seam.
- Direct mode maps tool calls to labels at `builder.ts:190-208` (`activityLabels`); **`tool_result` is received and ignored today** — AC10 wants step completion.
- Subscription mode (`createServerBuilder`, `builder.ts:80-139`) must now handle the new `step` SSE event from Phase 2.
- **CRITICAL — two inspectors, not one.** `apps/playground/src/run/inspector.ts` is the **bridge/frame** inspector and is deliberately **structural-only** (no payload values ever), enforced by marker assertions at `apps/playground/src/__tests__/inspector.test.ts:64` and `:105`. **Do NOT extend it.** Build a NEW sibling module (e.g. `run/llmInspector.ts` + panel) as a new rail tab; RunView's tabs are at `run/RunView.tsx:41` (`chat | inspector | docs | versions`).
- LLM inspector must be **in-memory only** (AC14: assert nothing written to the user DB, and ring-buffer it) and must **never render a BYOK key** (AC15 negative test).
- `ChatLog.tsx` and `BuilderView.tsx` have **no component tests today** — AC9 adds the first.

### Resume at PHASE 6 (Phases 4 and 5 are DONE — see their journal entries)

- **Phase 4 — `packages/db` cascade delete (AC16–21, AC23).** Highest-risk item. There are **zero foreign keys** in the user DB and `PRAGMA foreign_keys` is **never set**, so cascade is entirely hand-written. Owner explicitly confirmed: **delete pinned rows too — the factory version AND the bootstrap chat message**. Do NOT reuse `pruneChatMessages` or the version-retention helper: both refuse pinned rows. Use the `BEGIN IMMEDIATE`/`ROLLBACK` pattern from `writeBack` (`packages/db/src/userdb/userdb.ts:644-701`) and the module-private `restTablesFor(token)` helper (`:524-528`); token = `appDataToken(appId)`. **Resurrection hazard (R1)**: the materializer rebuilds rest tables from the still-open runtime copy on flush — invalidate `namespaceByFile` (`:504`) and `lastSavedHash` (`:506`) and close the inner driver, modelled on `importUserDb` (`:1281-1285`). Must `markDirty()` + flush so the delete reaches the exported bytes (AC23).
- **Phase 5 — hub UI delete (AC22).** `HubView.tsx:141-158` tiles are a `<Link>` **wrapping** a Card — restructure to Card **containing** Link + action. `danger` Button variant already exists (`ui/Button.tsx:4`). Inline confirm, **no `window.confirm`** (forbidden by the design contract); nearest pattern is the `.factory-reset` callout at `run/VersionsPanel.tsx:83-92`. Latch double-clicks like `HubView.tsx:32`. Add `delete` to `LibraryStore` (`state/library.ts:20-26`).
- **Phase 6 — knowledge + examples (AC24–27) + accept ADR-0011.** Rewrite the opening of `packages/knowledge/prompts/knowledge-base/app-authoring/10-overview-and-contract.md` (it currently *defines* an app as one that "thinks through the host's agent at runtime" — the doctrine gap) and add an autonomous/local-only archetype to `50-app-catalog.md` (its table has an "Agent's role" for all nine archetypes). Regenerate `packages/knowledge/src/generated/content.ts`. **Port the attached pig game to the contract** — keep gameplay/art/audio verbatim, but swap raw `postMessage`/`cheo-app-announce` for the byte-identical hooks block from `packages/sdk/embedded/snug-hooks.js` (**copy, never retype** — lesson 2026-07-31) and move the `localStorage` high score to `usePersistedState` (localStorage silently never persists in a null-origin iframe). `node --test examples/validate.test.mjs` must pass **unchanged** — do not relax the validator.
  - The attached HTML fails the validator on 4 counts: no hooks block / no `useSnugApp({`, `localStorage`, `cheo-app-announce` announce type, and no `// 5. RESPONSE SCHEMA` banner (the extractor needs it).
  - **The owner's source HTML is saved in-repo** at `docs/tasks/active/TASK-20260803-hub-ops-assets/flying-pigs-source.html` (verbatim, with a header comment listing the four violations). Phase 6 does **not** need it re-attached. Delete that assets folder as part of Gate 6 once `examples/flying-pig/app.html` is ported.

### Gate 5 / Gate 6 reminders
- Gate 5: run `pnpm test` at root **plus** `node --test examples/validate.test.mjs` **plus** the Playwright suite (`pnpm --filter playground test:e2e`). High tier also wants an independent adversarial review before merge (lesson 2026-07-31).
- Gate 6 (`/close-session`): journal, lessons, doc drift (`architecture.md`, `code-map.md`, `next-steps.md`), flip **ADR-0011 draft → accepted**, and move this file to `docs/tasks/done/` on merge. **No spec-changelog entry needed — `packages/protocol` is deliberately untouched.**
