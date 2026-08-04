# TASK-20260803-hub-ops: long-run builds, build observability, app delete, LLM-free apps

- **Status**: planned (awaiting plan approval)
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
