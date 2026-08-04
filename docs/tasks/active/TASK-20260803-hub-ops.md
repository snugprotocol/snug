# TASK-20260803-hub-ops: long-run builds, build observability, app delete, LLM-free apps

- **Status**: in-progress — **Phases 0–2 done and committed; resume at Phase 3** (see the handoff at the bottom of this file)
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

---

## HANDOFF — resume here (written 2026-08-03, end of session)

**Branch**: `feat/TASK-20260803-hub-ops` (off `main`), working tree **clean**.

```
8715521 Phase 2 — server: 30-min lifetimes + SSE step events
a5454f8 Phase 1 — adapters: the real long-build fix
381939d Phase 0 — SSO render-condition tests + enable runbook
d4a5bc5 Gate 1-2 — spec, interview, plan, ADR-0011 draft
```

**Baseline to preserve**: `pnpm test` → 19/19 tasks, 666 tests. Per-package: protocol 103 · knowledge 55 · runner 91 · db 145 · sdk 33 · server 94 · adapters 72 · playground 73. (Deltas so far: adapters 56→72, server 91→94, playground 67→73.)

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

### Resume at PHASE 3 — playground step timeline + LLM inspector

Covers **AC9–AC15**. Tests FIRST (Gate 3). Read `docs/engineering/TDD.md` and this file's Plan section before starting.

**Key facts already established — don't re-investigate:**
- `useBuilderChat` (`apps/playground/src/agent/useBuilderChat.ts`) currently exposes `activity: string | undefined` — a **single last-write-wins slot**, rendered in exactly ONE place: `apps/playground/src/views/ChatLog.tsx:47-52` (`.reasoning-pill`). Replace with a `steps: BuildStep[]` model.
- `activity` is set at `useBuilderChat.ts:197` (initial), `:238` (artifact save), `:260` (from `onActivity`), cleared at `:229` on first delta and `:308` in `finally`.
- `BuildHandlers` (`apps/playground/src/agent/builder.ts:40-49`) already has `onDelta` / `onArtifact` / `onActivity` / `onKnowledge` — **add `onStep` and `onRoundTrip` here**; this is the seam.
- Direct mode maps tool calls to labels at `builder.ts:190-208` (`activityLabels`); **`tool_result` is received and ignored today** — AC10 wants step completion.
- Subscription mode (`createServerBuilder`, `builder.ts:80-139`) must now handle the new `step` SSE event from Phase 2.
- **CRITICAL — two inspectors, not one.** `apps/playground/src/run/inspector.ts` is the **bridge/frame** inspector and is deliberately **structural-only** (no payload values ever), enforced by marker assertions at `apps/playground/src/__tests__/inspector.test.ts:64` and `:105`. **Do NOT extend it.** Build a NEW sibling module (e.g. `run/llmInspector.ts` + panel) as a new rail tab; RunView's tabs are at `run/RunView.tsx:41` (`chat | inspector | docs | versions`).
- LLM inspector must be **in-memory only** (AC14: assert nothing written to the user DB, and ring-buffer it) and must **never render a BYOK key** (AC15 negative test).
- `ChatLog.tsx` and `BuilderView.tsx` have **no component tests today** — AC9 adds the first.

### Then PHASES 4–6 (unchanged from the Plan section above)

- **Phase 4 — `packages/db` cascade delete (AC16–21, AC23).** Highest-risk item. There are **zero foreign keys** in the user DB and `PRAGMA foreign_keys` is **never set**, so cascade is entirely hand-written. Owner explicitly confirmed: **delete pinned rows too — the factory version AND the bootstrap chat message**. Do NOT reuse `pruneChatMessages` or the version-retention helper: both refuse pinned rows. Use the `BEGIN IMMEDIATE`/`ROLLBACK` pattern from `writeBack` (`packages/db/src/userdb/userdb.ts:644-701`) and the module-private `restTablesFor(token)` helper (`:524-528`); token = `appDataToken(appId)`. **Resurrection hazard (R1)**: the materializer rebuilds rest tables from the still-open runtime copy on flush — invalidate `namespaceByFile` (`:504`) and `lastSavedHash` (`:506`) and close the inner driver, modelled on `importUserDb` (`:1281-1285`). Must `markDirty()` + flush so the delete reaches the exported bytes (AC23).
- **Phase 5 — hub UI delete (AC22).** `HubView.tsx:141-158` tiles are a `<Link>` **wrapping** a Card — restructure to Card **containing** Link + action. `danger` Button variant already exists (`ui/Button.tsx:4`). Inline confirm, **no `window.confirm`** (forbidden by the design contract); nearest pattern is the `.factory-reset` callout at `run/VersionsPanel.tsx:83-92`. Latch double-clicks like `HubView.tsx:32`. Add `delete` to `LibraryStore` (`state/library.ts:20-26`).
- **Phase 6 — knowledge + examples (AC24–27) + accept ADR-0011.** Rewrite the opening of `packages/knowledge/prompts/knowledge-base/app-authoring/10-overview-and-contract.md` (it currently *defines* an app as one that "thinks through the host's agent at runtime" — the doctrine gap) and add an autonomous/local-only archetype to `50-app-catalog.md` (its table has an "Agent's role" for all nine archetypes). Regenerate `packages/knowledge/src/generated/content.ts`. **Port the attached pig game to the contract** — keep gameplay/art/audio verbatim, but swap raw `postMessage`/`cheo-app-announce` for the byte-identical hooks block from `packages/sdk/embedded/snug-hooks.js` (**copy, never retype** — lesson 2026-07-31) and move the `localStorage` high score to `usePersistedState` (localStorage silently never persists in a null-origin iframe). `node --test examples/validate.test.mjs` must pass **unchanged** — do not relax the validator.
  - The attached HTML fails the validator on 4 counts: no hooks block / no `useSnugApp({`, `localStorage`, `cheo-app-announce` announce type, and no `// 5. RESPONSE SCHEMA` banner (the extractor needs it).
  - **The owner's source HTML is saved in-repo** at `docs/tasks/active/TASK-20260803-hub-ops-assets/flying-pigs-source.html` (verbatim, with a header comment listing the four violations). Phase 6 does **not** need it re-attached. Delete that assets folder as part of Gate 6 once `examples/flying-pig/app.html` is ported.

### Gate 5 / Gate 6 reminders
- Gate 5: run `pnpm test` at root **plus** `node --test examples/validate.test.mjs` **plus** the Playwright suite (`pnpm --filter playground test:e2e`). High tier also wants an independent adversarial review before merge (lesson 2026-07-31).
- Gate 6 (`/close-session`): journal, lessons, doc drift (`architecture.md`, `code-map.md`, `next-steps.md`), flip **ADR-0011 draft → accepted**, and move this file to `docs/tasks/done/` on merge. **No spec-changelog entry needed — `packages/protocol` is deliberately untouched.**
