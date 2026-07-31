# Snug — Architecture

> Status: **scaffold** (2026-07-31). This describes the v1 target; packages are stubs until their week lands (see [next-steps.md](next-steps.md)). Corrected at Gate 6 whenever reality drifts.

## Components

```
┌────────────────────────── host product (or Playground) ──────────────────────────┐
│                                                                                  │
│  chat UI ──► agent endpoint (apps/server /invoke, SSE) ──► packages/adapters ──► LLM
│                    ▲                                                             │
│                    │ envelopes (JSON, versioned)                                 │
│  packages/runner ──┘   ← bridge: relays iframe postMessage ↔ agent endpoint      │
│      │ sandboxed iframe (allow-scripts, connect-src 'none', CDN allowlist)       │
│      ▼                                                                           │
│  micro app (single-file HTML, authored by LLM via packages/knowledge)            │
│      │ useAgentBridge / usePersistedState / useAppDB   (packages/sdk)            │
│      ▼                                                                           │
│  packages/db — sql.js per-app DB → OPFS → .sqlite export                         │
└──────────────────────────────────────────────────────────────────────────────────┘
       packages/protocol = envelope types + zod schemas (source of truth for spec)
       packages/auth (v1.1) = server-side credential broker (C1 token boundary)
```

## Dependency graph (who depends on whom → whose tests also run)

- `protocol` ← `runner`, `sdk`, `server`, `adapters`, `playground` (change protocol → run everything)
- `db` ← `sdk`, `playground`
- `knowledge` ← `server`, `playground`
- `adapters` ← `server`
- `runner` ← `playground`
- `auth` ← `server` (v1.1)

## External dependencies
LLM providers (Anthropic primary, OpenAI; always through `adapters`, never direct). sql.js (WASM SQLite). OPFS (browser). SQLite file storage in `apps/server` for artifacts. No cloud services required for OSS usage; Playground deploys to Azure Static Web Apps (bring-your-own-API-key).

## North-star (aspirational, clearly not current)
Multi-implementation protocol (non-JS SDKs), hub features (pin/share/install) as optional packages, KeyProvider/KMS for cryptographic host-blindness, CI-enforced spec-sync.
