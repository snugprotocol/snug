# Snug — Architecture

> Status: **implemented (portable-hub evolution, pre-launch)** — 2026-08-03, TASK-20260803-portable-hub (on the v1 core of TASK-20260731-build-hub). Three-actor model: LLM providers · hub providers · the end user who owns ONE portable SQLite file. Wire protocol unchanged at v1; storage/hub behavior is spec v0.2 draft (`docs/spec-drafts/spec-v0.2-userdb.md`). Auth broker (app credentials) remains v1.1 — hub LOGIN shipped separately in `apps/server`.

## Components

```
┌────────────────────── hub client (static files — no backend REQUIRED) ───────────────────┐
│                                                                                          │
│  chat UI ──► AgentTransport seam ──┬─ byok:  in-page runAgentTurn ──► provider API       │
│      ▲                             ├─ local: in-page runAgentTurn ──► localhost LLM      │
│      │ envelopes (JSON, v1)        └─ subscription: /invoke SSE ──► hub's adapter        │
│  packages/runner ◄─┘   bridge: iframe postMessage ↔ transport (host page ONLY — C1/C2)   │
│      │ sandboxed iframe (allow-scripts, connect-src 'none', CDN allowlist)               │
│      ▼                                                                                   │
│  micro app (single-file HTML, authored by LLM via packages/knowledge)                    │
│      │ useSnugApp / usePersistedState / useAppDB   (packages/sdk)                        │
│      ▼                                                                                   │
│  packages/db USER DB (ADR-0007): ONE sql.js file/user — apps + versions (≥5, revert) +   │
│  chats + settings + secrets + per-app data as blob-embedded standalone SQLite DBs        │
│      │  OPFS runtime copy (crash-safe A/B slots) · export/import (secrets stripped)      │
│      ▼                                                                                   │
│  packages/db sync (ADR-0009): SyncProvider → hub origin (/userdb CAS) | Dropbox | …      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
   packages/protocol = envelope/frames (v1) + userdb-schema.ts (spec v0.2 storage surface)
   apps/server (OPTIONAL hub) = /invoke + artifact cache + Google OIDC + /userdb + static
   packages/auth (v1.1) = server-side APP-credential broker (C1) — untouched by the hub login
```

Key invariants: the user DB is the single source of truth in EVERY mode (subscription
artifacts are fetched client-side and written into it — hub stores are transient
caches); LLM calls originate from the host page only; secrets never reach the hub
(stripped from sync pushes and default exports, VACUUMed).

## Dependency graph (who depends on whom → whose tests also run)

- `protocol` ← `runner`, `sdk`, `server`, `adapters`, `db`, `playground` (change protocol → run everything)
- `db` ← `sdk`, `playground` (userdb schema constants come FROM protocol)
- `knowledge` ← `server`, `playground`
- `adapters` ← `server`, `playground` (browser-direct byok/local)
- `runner` ← `playground`
- `auth` ← `server` (v1.1)

## External dependencies
LLM providers: Anthropic + OpenAI via `adapters` — browser-direct in byok mode (CORS opt-in header), any OpenAI-compatible localhost endpoint in local mode (Ollama), hub-side in subscription mode. sql.js (WASM SQLite), OPFS (browser). Hub server: better-sqlite3 stores, openid-client (Google OIDC), @fastify/{cookie,static,cors}. Dropbox HTTP API (example personal sync origin, PKCE public client). No cloud services required for OSS usage.

## North-star (aspirational, clearly not current)
Multi-implementation protocol (non-JS SDKs), true network-offline app runtime (vendored-runtime template — apps currently load React from the CDN allowlist), desktop local hub, OneDrive/Drive/S3 SyncProviders, CRDT multi-device merge, KeyProvider/KMS for cryptographic host-blindness, CI-enforced spec-sync.
