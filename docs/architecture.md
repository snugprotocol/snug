# Snug — Architecture

> Status: **implemented (living-apps evolution + hub ops + hub polish + observability/caching, pre-launch)** — 2026-08-05, TASK-20260804-observability-caching (on TASK-20260804-hub-polish (on TASK-20260803-hub-ops (on living-apps, TASK-20260803-living-apps, on portable-hub, TASK-20260803-portable-hub). Hub ops added: long-run builds (48-iteration ceiling — there was never a timeout), 30-minute server lifetimes, a build step timeline, an in-memory LLM round-trip inspector (a SIBLING of the structural frame inspector, never an extension), cascade app delete with a terminal-delete tombstone, and the LLM-optional app doctrine (ADR-0011)). Hub polish added: a header identity menu with the Google avatar, the ember-niche brand mark, one merged "think" rail surface, round-trip observability in the build view AND the app-frame transport, explicit starter install (a starter is read-only until owned), build-thread continuity, and CAS conflicts that reach the divergence resolver instead of throwing. Observability/caching added: LIVE round-trip observation (calls and tools appear as they start, each timed), the wire model name, prompt caching on the stable tools+system prefix of BUILDER turns only (a per-TURN request flag — the app-frame envelopes are below the cacheable minimum and deliberately excluded) (ADR-0012), cache-hit reporting as a cached %, and a rotating status line replacing the duplicate step timeline. The inspector's memory bound moved from a per-field ingest cap to a total-bytes budget so expanded payloads can be shown whole.) Three-actor model: LLM providers · hub providers · the end user who owns ONE portable SQLite file. Apps are LIVING: LLM-designed native data schemas (ADR-0010), app-attached chat with compounding per-app wiki docs, factory-pinned versions. Wire protocol unchanged at v1; storage/hub behavior is spec v0.2 draft schema v2 (`docs/spec-drafts/spec-v0.2-userdb.md`). Auth broker (app credentials) remains v1.1 — hub LOGIN shipped separately in `apps/server`.

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
│      │ useSnugApp / usePersistedState / useAppDB / useConnectedFetch   (packages/sdk)    │
│      │ net-request/net-response frames (AL-03, internal draft) ──► runner NetHandler ──► │
│      │   packages/auth connected-fetch executor (host-only fetch caller; injects creds,  │
│      │   scrubs responses; app iframe still has connect-src 'none' — C1/C2 intact)       │
│      ▼                                                                                   │
│  packages/db USER DB (ADR-0007/0010): ONE sql.js file/user — apps + versions (factory    │
│  pinned + 5 recent, revert/reset) + chats (bootstrap turn pinned) + per-app wiki docs +  │
│  schema registry + settings + secrets + per-app data as NATIVE app_<token>__* tables,    │
│  materialized into the app's own runtime DB at load (physical isolation preserved)       │
│      │  OPFS runtime copy (crash-safe A/B slots) · export/import (secrets stripped)      │
│      ▼                                                                                   │
│  packages/db sync (ADR-0009): SyncProvider → hub origin (/userdb CAS) | Dropbox | …      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
   packages/protocol = envelope/frames (v1) + net-request/net-response (AL-03 internal
     draft, own size class, NOT in schemas/) + userdb-schema.ts (spec v0.2 storage
     surface; v3 internal draft adds snug_auth_specs) + auth-schema.ts (internal)
   apps/server (OPTIONAL hub) = /invoke + artifact cache + Google OIDC + /userdb + static
   packages/auth (AL-02/AL-03, ADR-0014) = Dynamic Auth pure core + connected-fetch
     runtime, LOCAL-FIRST: browser-safe DI-pure OAuth service + CredentialStore over the
     user file's snug_secrets `auth:` keys — credentials live in the USER'S file, never a
     server vault; host ceiling always strict (C1, no knob). The connected-fetch executor
     is the ONLY host-side fetch caller; injection is always strict (audit bug 3 dead by
     construction). Wizard/UI lands in AL-04.
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
- `auth` depends on `protocol` + `db` (CredentialStore seats on the user DB); `playground` now consumes it (AL-03 wires the connected-fetch executor into the runner's NetHandler seam) — change `auth` → run `auth` + `playground`. `runner` does NOT depend on `auth` (value-blind by lint, R4).

## External dependencies
LLM providers: Anthropic + OpenAI via `adapters` — browser-direct in byok mode (CORS opt-in header), any OpenAI-compatible localhost endpoint in local mode (Ollama), hub-side in subscription mode. Experimental: `@mlc-ai/web-llm` (pinned, playground-only, code-split) runs a small model in-page on WebGPU behind the `?webllm=1` flag — same AgentAdapter contract via a brain OVERRIDE of the configured mode, tool-free fenced-HTML build path, demo-brain fallback when WebGPU is absent (ADR-0015; GA at 1.2). sql.js (WASM SQLite), OPFS (browser). Hub server: better-sqlite3 stores, openid-client (Google OIDC), @fastify/{cookie,static,cors}. Dropbox HTTP API (example personal sync origin, PKCE public client). No cloud services required for OSS usage.

## North-star (aspirational, clearly not current)
Multi-implementation protocol (non-JS SDKs), true network-offline app runtime (vendored-runtime template — apps currently load React from the CDN allowlist), desktop local hub, OneDrive/Drive/S3 SyncProviders, CRDT multi-device merge, KeyProvider/KMS for cryptographic host-blindness, CI-enforced spec-sync.
