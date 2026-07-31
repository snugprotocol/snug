# TASK-20260731-server-adapters: `packages/adapters` + `apps/server` (child 5 of build-hub)

- **Status**: in-progress
- **Owner**: Jeetu (delegated session)
- **Risk tier**: medium (C1 enforcement point — negative tests mandatory)
- **Branch**: `feat/TASK-20260731-server-adapters`
- **Packages touched**: `packages/adapters` (new), `apps/server` (new); consumes protocol/knowledge/runner-interfaces
- **Spec impact**: none (implements existing contracts)
- **Related**: umbrella P2#5; runner transport contract (F6) + ADR-0006 header-CSP obligation; knowledge assembly API

## Spec (what & why)

**`packages/adapters`** — browser-safe (BYOK playground calls them directly), fetch-based:
- `AgentAdapter` interface: `complete({system, messages, tools?, signal, onDelta}) → Promise<AdapterResult>` — errors as data (`{ok:false, code, message, retryable}`), deltas streamed. Tool-use supported (the app-builder KB tool + artifact write run through it).
- `anthropicAdapter({apiKey, model?})` (Messages API, streaming, tool use), `openaiAdapter({apiKey, model?})` (Chat Completions, streaming, tools), `mockAdapter(script)` (deterministic: scripted turns incl. tool calls + canned app HTML — powers tests, offline demo, and the E2E).
- `createHttpTransport(invokeUrl, opts?)` — the runner `AgentTransport` client: POST + SSE, heartbeat-tolerant parser (one malformed block never kills the stream — ancestor pattern), maps conditions→codes (409→`THREAD_CONFLICT`, abort→clean, network→`NETWORK_ERROR`, mid-stream drop→`STREAM_DROPPED` retryable), deltas to `onDelta`, post-settle events ignored.
- **One choke point**: providers are called ONLY via `runAgentTurn()` (the shared agent loop in adapters: system prompt + messages + tool dispatch loop + JSON-only mode) — used by both server and BYOK playground. No other module touches a provider.

**`apps/server`** — Fastify reference backend:
- `POST /invoke` (SSE): body `{message, threadId?}` → **C1 boundary first**: strip credential headers from the inbound request context; reject payloads whose envelope fails `scanForCredentialValues` high-confidence rejects. Then: `isAppRequest(message)` ? **app path** (skip thread history — envelope self-contained; JSON-only reply; no tools) : **chat path** (thread history from store; `buildHostSystemPrompt({appBuilder:true, artifacts:true})`; tools enabled: `snug_app_builder` → `searchKnowledge(query)`, `artifact_write` → artifact store). SSE events: `delta`, `artifact {artifactId, displayName}`, `done {text}`, `error {code, message, retryable}`; 15s heartbeat comments.
- Artifact store: SQLite (better-sqlite3) metadata + HTML content; ≤ `MAX_ARTIFACT_BYTES`; `GET /artifacts/:id` serves HTML **with the authoritative CSP HTTP header = runner's `RUNNER_CSP`** (ADR-0006 obligation) + `X-Content-Type-Options: nosniff`; `GET /artifacts` list; thread store (SQLite) with history cap.
- Config via env (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`SNUG_ADAPTER=mock`), secrets only here (C5); CORS for the playground origin; no auth (single-user OSS reference; hub auth out of v1 scope).

**Acceptance criteria** (each ≥1 test):
1. **C1-neg**: inbound `Authorization`/`Cookie`/`X-Api-Key` headers never reach adapter payloads (spy adapter asserts); envelope `payload/state` planted with `Bearer …` → 400 typed reject; `{token:'rook'}` passes.
2. App path: valid envelope → history NOT loaded (spy), system prompt includes response-format layer, reply parsed via `parseAgentReply` semantics server-side untouched (raw text streamed; runner parses) — assert raw passthrough.
3. Chat path: mock adapter scripted to call `snug_app_builder` then `artifact_write` → KB sections served, artifact persisted (≤cap), SSE `artifact` + `done` events in order.
4. SSE: heartbeats present; malformed block tolerated by `createHttpTransport`; 409 → `THREAD_CONFLICT` retryable; abort mid-stream → clean; drop → `STREAM_DROPPED`.
5. Artifact serving: CSP header === `RUNNER_CSP` byte-exact (import, not retyped); nosniff; 404 typed; oversized write rejected.
6. Adapters: anthropic/openai request-shape tests against recorded fixtures (no live calls): system placement, tool schema mapping, streaming assembly, error mapping (429/500→retryable, 401→not); mock adapter determinism.
7. `runAgentTurn` loop: tool-call round-trips (max-iterations cap), JSON-only mode passes tools:none.
8. Centralization lint stays green (no prompt literals in server/adapters — all via knowledge).
9. Root `pnpm test` green; `pnpm --filter server dev` boots with mock adapter and completes a scripted /invoke (smoke test).

**Out of scope**: auth broker (v1.1); multi-tenant; S3; rate limiting beyond a simple per-IP cap on /invoke.

## Plan
adapters first (interfaces → mock → http-transport → anthropic/openai + fixtures → runAgentTurn), then server (stores → routes → C1 boundary → SSE) then cross tests. Deps: fastify, @fastify/cors, better-sqlite3 (server); none new for adapters (fetch native). Tests first per area.

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: task file. Next: implement (delegated), review, merge.
