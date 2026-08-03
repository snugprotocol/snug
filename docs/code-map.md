# Snug — Code Map ("where does X live")

> Status: scaffold — stubs marked ⭕; update at Gate 6 as code lands.

| Area / concept | Location | Tests |
|---|---|---|
| Envelope message types, zod schemas, JSON Schema export | `packages/protocol/src` ✅ (frames/envelope/reply/security/json-schemas) | `packages/protocol` vitest (74) |
| Iframe runner, CSP/sandbox, bridge host, transport/db-driver seams, browser-CSP suite template | `packages/runner/src` ✅ | `packages/runner` vitest (90) + child-6 Playwright |
| In-app hooks (useSnugApp/usePersistedState/useAppDB; embedded + module forms, KB≡SDK sync) | `packages/sdk/src` + `packages/sdk/embedded` ✅ | `packages/sdk` vitest (33) |
| Per-app DB (sql.js + OPFS/IDB/memory, .sqlite export/import, kv, DbDriver) | `packages/db/src` ✅ | `packages/db` vitest |
| **User DB** (ADR-0007: one file/user, versions+revert, chats, settings, secrets, blob-embedded app DBs, corrupt-quarantine, size caps) | `packages/db/src/userdb` ✅ | `packages/db` vitest (114 total) |
| User-DB spec constants (DDL, limits, OPFS names — spec v0.2 surface, snapshot-locked) | `packages/protocol/src/userdb-schema.ts` ✅ | `packages/protocol` vitest |
| Crash-safe OPFS persistence (A/B slots + pointer, teardown-proof) | `packages/db/src/persistence.ts` ✅ | `packages/db` vitest |
| Sync (ADR-0009: SyncProvider, sidecar, serialized loop, LWW-on-explicit-action, hub-origin + Dropbox providers, restore) | `packages/db/src/sync` ✅ | `packages/db` vitest (44) |
| Credential broker (v1.1) | `packages/auth/src` ⭕ | `packages/auth` |
| Central prompt store (ADR-0004: system/KB/tools/skills/templates/ui layers) + typed loaders, assembly, search, centralization lint | `packages/knowledge/prompts` + `packages/knowledge/src` ✅ | `packages/knowledge` vitest (55) |
| Provider adapters (anthropic/openai/mock), runAgentTurn choke point, http SSE transport | `packages/adapters/src` ✅ | `packages/adapters` vitest (56) |
| Reference backend (/invoke SSE + model override, C1 boundary, artifact cache, Google OIDC + sessions/CSRF, /userdb CAS endpoints, static hosting, fail-closed config) | `apps/server/src` ✅ | `apps/server` vitest (89) |
| Playground (hub · builder · run+inspector+versions · byok/local/subscription · user-DB state · sync/export/import · login) | `apps/playground/src` ✅ | vitest (51) + Playwright (25, incl. the C2 real-browser CSP gate + AC2 serverless gates) |
| Artifact target pinning (F9: per-app chat pins, builder thread installs-then-versions) | `apps/playground/src/agent/artifactSink.ts` ✅ | playground vitest |
| Spec v0.2 draft staging (Portable User Database Format) | `docs/spec-drafts/spec-v0.2-userdb.md` ✅ | — (push needs explicit ask) |
| Example apps (single-file, embedded hooks byte-synced to sdk) | `examples/{chess,flying-pig,habit-tracker}` ✅ | `examples` validate suite (18) |
| Spec publication process | `docs/engineering/SPEC_SYNC.md` + `docs/spec-changelog.md` | future `scripts/check-spec-sync` |
| Process, tiers, release rules | `docs/engineering/PROCESS.md` | — |
| Pre-launch strategy (private, C4) | `internal/` | — |
