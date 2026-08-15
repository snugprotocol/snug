# Architecture Decision Records (ADRs)

Append-only decision log for Snug. One file per decision: `NNNN-short-kebab-title.md`. Never rewrite or delete a past ADR — a reversal is a new ADR that supersedes it. Status: `accepted` · `superseded by NNNN` · `proposed`.

## Template

```markdown
# NNNN — <Title>

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Task:** TASK-YYYYMMDD-slug

## Context
## Decision
## Alternatives considered
## Consequences
```

## Index

- [0001 — Adopt the agentic engineering process](0001-adopt-agentic-engineering-process.md)
- [0002 — Two-repo topology: snug (master) drives spec (downstream)](0002-snug-master-spec-downstream.md)
- [0003 — v1 scope and hard security constraints inherited from prior production systems](0003-v1-scope-and-security-constraints.md)
- [0004 — Central layered prompt store](0004-central-layered-prompt-store.md)
- [0005 — Playground is a Vite + React SPA](0005-playground-vite-spa.md)
- [0006 — Runner CSP allows 'unsafe-eval' + a fixed CDN allowlist](0006-runner-csp-unsafe-eval-cdn.md)
- [0007 — Single portable per-user SQLite DB with per-app namespaces and app versioning](0007-single-portable-user-db.md)
- [0008 — Serverless app execution; LLM calls from the host page, never from the app iframe](0008-serverless-execution-host-llm-bridge.md)
- [0009 — User-DB sync: OPFS runtime copy, pluggable SyncProvider origins, LWW v1](0009-sync-provider-origins.md)
- [0010 — Per-app data as LLM-designed native tables; materialized runtime DB for isolation](0010-app-native-schemas-materialized-runtime.md)
- [0011 — Apps are LLM-optional: the agent is a capability, not a requirement](0011-llm-optional-apps.md)
- [0012 — Prompt caching is a per-turn decision, scoped to builder/agent turns](0012-prompt-caching-scope.md)
- [0013 — Hosted hub is static files only (zero-backend doctrine)](0013-hosted-hub-static-zero-backend.md)
- [0014 — Credentials are local-first (custody doctrine)](0014-credentials-local-first.md)
- [0015 — WebLLM experimental mode: engine, model default, fallback](0015-webllm-experimental-mode.md)
- [0016 — Who may propose a connection (the trust ladder)](0016-connection-proposal-trust-ladder.md)
- [0017 — The requirement/grant split (amends ADR-0016)](0017-connection-requirement-and-grant.md)
- [0018 — App runtime turns assemble from an authored, version-pinned runtime contract](0018-runtime-prompt-contract.md)
- [0019 — App chat is intent-routed; data agency is scratch-isolated reads + human-approved writes](0019-intent-routed-app-chat-data-agency.md)
- [0020 — Multi-option auth: the host defaults, discloses, and the user rebinds](0020-multi-option-auth-kind.md)
- [0021 — Desktop shell transports: loopback OAuth, registry redirect postures, native fetch, file-backed userdb](0021-desktop-shell-transports.md)
- [0022 — Registry request seats, host-side signing functions, and auth-shaped failure surfacing](0022-registry-request-seats.md)
- [0023 — LAN-class providers: user-supplied bridge hosts, pairing exchanges, scoped TLS trust](0023-lan-class-providers.md)
- [0024 — The think rail is user-sized and dismissible; the frame view is deleted while its feed lives on](0024-think-rail-user-sized-frames-view-removed.md)
- [0025 — LAN pairing verifies before it claims; LAN rows never route through the api-key screens](0025-lan-pairing-verify-before-claim.md) _(proposed)_
- [0026 — Connection-relative addressing: apps name their connection, never its host](0026-connection-relative-addressing.md) _(proposed)_
