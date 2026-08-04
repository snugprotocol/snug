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
