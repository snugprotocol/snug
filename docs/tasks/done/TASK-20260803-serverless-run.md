# TASK-20260803-serverless-run: Serverless run, provider+model picker, local LLM (child 2 of portable-hub)

- **Status**: done (merged via PR)
- **Owner**: Jeetu
- **Risk tier**: medium (High where C1/C2 suites are brushed — they must stay green untouched)
- **Branch**: `feat/TASK-20260803-portable-hub` (umbrella branch)
- **Packages touched**: `adapters`, `apps/playground`, `apps/server` (/invoke `model` field)
- **Spec impact**: none (wire unchanged; `/invoke` body gains optional zod-validated `model`)
- **Related**: umbrella [TASK-20260803-portable-hub](TASK-20260803-portable-hub.md) (§Amendments F13, F15, F16, F17), ADR-0008

## Spec (what & why)

Generalize BYOK into the default execution architecture: mode = `byok | local | subscription`; provider+model picker; OpenAI-compatible local endpoint (Ollama default `http://localhost:11434/v1`); playground state (mode/provider/model/keys/app meta/library) moves into the user DB. Old IndexedDB/localStorage stores abandoned (pre-launch, F13).

**Acceptance criteria** (umbrella AC2/AC3/AC4/AC6-partial):
1. Playwright: with no server process, install starter → run → write data → reload → persists (OPFS user DB).
2. C1/C2 suites green; new probes: BYOK key never in any frame posted to the iframe; zero requests to hub origin during a BYOK turn.
3. Local provider: unit tests against mocked OpenAI-compatible endpoint; targeted picker errors for Ollama CORS (`OLLAMA_ORIGINS`) and https/mixed-content (F17).
4. `anthropic.ts` sends `anthropic-dangerous-direct-browser-access`; `model` plumbs through all adapters and `/invoke` (validated).
5. Settings read/write `snug_settings`/`snug_secrets`; key absent from localStorage/sessionStorage (AC11 storage-negatives); imported/pulled endpoint settings require re-confirmation before first use (F15).
6. Starter "install" writes HTML into `snug_apps` + `snug_app_versions` v1.

**Out of scope**: version UI/chat persistence (child 3), sync (child 4), auth (child 5).

## Plan

Files: `packages/adapters/src/{anthropic.ts,openai.ts,local.ts?,index.ts}` → `apps/playground/src/state/{mode.ts,appMeta.ts,library.ts}` rewired over `UserDb` → `views/SettingsView.tsx` picker → `agent/{adapter.ts,transport.ts,builder.ts}` mode routing → `apps/server/src/routes/invoke.ts` model field. Tests FIRST per AC.

## Decisions & surprises

—

## Session journal (append-only, newest last)

### 2026-08-03 15:00 — Jeetu/Claude — session
- Done: adapters — `localAdapter` (OpenAI-compatible, Ollama default, F17 error guidance), anthropic browser-CORS header, `model` option on `createHttpTransport`; server — `/invoke` accepts validated `model` + optional `makeAdapter` dep (app.ts wiring deferred to integration to avoid conflicting with child 5's app.ts work); db — persistence backends take a `dirName` (F13), `openUserDb` defaults to `snug-userdb/`, `UserDb.updateAppMeta` added; playground — `state/userdb.ts` singleton (corrupt = explicit recovery), mode.ts rewritten (byok|local|subscription, settings+secrets in user DB, F15 confirm guard), library.ts rewritten over user DB (IDB store abandoned per F13), appMeta over app rows, transport/adapter/builder rewired (async keys, model/localUrl), SettingsView (3-mode + model + local URL + confirm banner), HubView starter install→user DB, RunView uses shared user-DB driver, App boots/hydrates. Tests: 4 new adapters tests; playground suite rewritten where contracts changed — 39/39 green; storage negatives (key never in local/sessionStorage) + F15 guard pinned.
- State: ACs 2–6 unit-covered; AC1 (no-server Playwright) pending — consolidated with child 3's UI pass.
- Next step: child 3 (versions + chat persistence), then Playwright suite update incl. the no-server AC1 gate.
