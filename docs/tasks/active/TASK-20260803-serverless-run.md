# TASK-20260803-serverless-run: Serverless run, provider+model picker, local LLM (child 2 of portable-hub)

- **Status**: planned
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
