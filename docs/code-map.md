# Snug — Code Map ("where does X live")

> Status: scaffold — stubs marked ⭕; update at Gate 6 as code lands.

| Area / concept | Location | Tests |
|---|---|---|
| Envelope message types, zod schemas, JSON Schema export | `packages/protocol/src` ✅ (frames/envelope/reply/security/json-schemas) | `packages/protocol` vitest (74) |
| Iframe runner, CSP/sandbox, bridge host | `packages/runner/src` ⭕ | `packages/runner` (+ jsdom harness) |
| In-app hooks (`useAgentBridge`, `useAppDB`, `usePersistedState`) | `packages/sdk/src` ⭕ | `packages/sdk` |
| Per-app DB (sql.js + OPFS, .sqlite export) | `packages/db/src` ⭕ | `packages/db` |
| Credential broker (v1.1) | `packages/auth/src` ⭕ | `packages/auth` |
| LLM app-authoring knowledge base | `packages/knowledge/src` ⭕ | `packages/knowledge` |
| Provider adapters (anthropic/openai/mock) | `packages/adapters/src` ⭕ | `packages/adapters` |
| Reference backend (/invoke, artifact store) | `apps/server/src` ⭕ | `apps/server` |
| Playground (chat → build → run) | `apps/playground/src` ⭕ | `apps/playground` |
| Example apps | `examples/{chess,flying-pig,habit-tracker}` ⭕ | n/a (curated artifacts) |
| Spec publication process | `docs/engineering/SPEC_SYNC.md` + `docs/spec-changelog.md` | future `scripts/check-spec-sync` |
| Process, tiers, release rules | `docs/engineering/PROCESS.md` | — |
| Pre-launch strategy (private, C4) | `internal/` | — |
