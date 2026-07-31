# Snug — Code Map ("where does X live")

> Status: scaffold — stubs marked ⭕; update at Gate 6 as code lands.

| Area / concept | Location | Tests |
|---|---|---|
| Envelope message types, zod schemas, JSON Schema export | `packages/protocol/src` ✅ (frames/envelope/reply/security/json-schemas) | `packages/protocol` vitest (74) |
| Iframe runner, CSP/sandbox, bridge host, transport/db-driver seams, browser-CSP suite template | `packages/runner/src` ✅ | `packages/runner` vitest (90) + child-6 Playwright |
| In-app hooks (useSnugApp/usePersistedState/useAppDB; embedded + module forms, KB≡SDK sync) | `packages/sdk/src` + `packages/sdk/embedded` ✅ | `packages/sdk` vitest (33) |
| Per-app DB (sql.js + OPFS/IDB/memory, .sqlite export/import, kv, DbDriver) | `packages/db/src` ✅ | `packages/db` vitest (37) |
| Credential broker (v1.1) | `packages/auth/src` ⭕ | `packages/auth` |
| Central prompt store (ADR-0004: system/KB/tools/skills/templates/ui layers) + typed loaders, assembly, search, centralization lint | `packages/knowledge/prompts` + `packages/knowledge/src` ✅ | `packages/knowledge` vitest (55) |
| Provider adapters (anthropic/openai/mock), runAgentTurn choke point, http SSE transport | `packages/adapters/src` ✅ | `packages/adapters` vitest (56) |
| Reference backend (/invoke SSE, C1 boundary, artifact store w/ header CSP, thread lock) | `apps/server/src` ✅ | `apps/server` vitest (31) + smoke |
| Playground (hub · builder · run+inspector · BYOK; design tokens in `src/theme`) | `apps/playground/src` ✅ | vitest (36) + Playwright (23, incl. the C2 real-browser CSP gate) |
| Example apps (single-file, embedded hooks byte-synced to sdk) | `examples/{chess,flying-pig,habit-tracker}` ✅ | `examples` validate suite (18) |
| Spec publication process | `docs/engineering/SPEC_SYNC.md` + `docs/spec-changelog.md` | future `scripts/check-spec-sync` |
| Process, tiers, release rules | `docs/engineering/PROCESS.md` | — |
| Pre-launch strategy (private, C4) | `internal/` | — |
