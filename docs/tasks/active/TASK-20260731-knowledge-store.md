# TASK-20260731-knowledge-store: `packages/knowledge` — central prompt store, loaders, lint, skill-creator (child 2 of build-hub)

- **Status**: in-progress
- **Owner**: Jeetu (delegated session)
- **Risk tier**: medium
- **Branch**: `feat/TASK-20260731-knowledge-store`
- **Packages touched**: `packages/knowledge` (depends on `packages/protocol` for injected constants)
- **Spec impact**: none (consumes protocol constants; no schema change)
- **Related**: umbrella P1 + ADR-0004; survey `internal/05-prompt-ui-survey.md`

## Spec (what & why)

Implement ADR-0004: every LLM-bound prompt in the repo lives in `packages/knowledge/prompts/**`, layered by assembly order, each file carrying a mandatory header (layer / destination / blast-radius / source). Typed per-layer loaders inject protocol constants (`{{envelopeTag}}`, `{{appBuilderToolName}}`, `{{cdnAllowlist}}`, hook names) so no wire literal is ever retyped in prompt text. Content is a **rewrite for the Snug v0.1 protocol informed by both ancestors** (the ancestor KBs teach dead hooks/localStorage — C2 forbids that now), not a verbatim port. The vendored Anthropic skill-creator is the exception: verbatim, commit-pinned, Apache-2.0 attribution carried.

Layers: `prompts/system/{10-host-identity,20-capability-file-creation,30-app-builder-summary,40-app-response-format}.md` · `prompts/knowledge-base/app-authoring/*.md` (## structure is retrieval-load-bearing) · `prompts/tools/*.md` · `prompts/skills/{skill-creator/** (vendored), builder-preamble.md, modes/*.md}` · `prompts/templates/user-identity.md` · `prompts/ui/*.md` · `prompts/README.md` (the map).

**In-app SDK contract taught by the KB** (child 4 implements to match; a sync test will lock KB hook code ≡ sdk source): `useSnugApp({appId, displayName, description?, iconEmoji?, iconColor?})` → `{isReady, theme, isWaiting, lastResponse, sendMessage(action, payload?, opts?) → Promise<{ok,data|error}>}` (requestId/UUID + instanceId handled inside; streaming via `opts.onStream`); `usePersistedState(key, initial)` over kv db-frames; `useAppDB()` → `{exec, export, import}` over db-frames. Apps are single-file HTML; hooks are copy-exactly template code inside the KB (apps stay dependency-free).

**Acceptance criteria** (each ≥1 test):
1. Every file under `prompts/` (except vendored `skill-creator/**`) has the required header; test walks and fails on violations.
2. No protocol literal retyped: tests assert rendered prompts contain `SNUG_APP_REQUEST_TAG`/tool name via injection and that raw prompt sources contain `{{placeholders}}`, not the literals.
3. Centralization lint: repo-level test fails on LLM-bound prompt text outside the store (heuristic: multi-line template literals > 400 chars containing prompt markers in `packages/*/src`/`apps/*/src`, excluding knowledge + tests); currently green.
4. Golden assembly snapshots: `buildHostSystemPrompt({appBuilder, artifacts})` gating matrix (4 combos) snapshot-tested; app-builder block appears iff enabled (ancestor triple-gate pattern, simplified to config).
5. KB section search: `searchKnowledge(query)` returns `##`/`###`-sectioned matches with keyword scoring, full-document fallback; heading structure asserted stable.
6. Vendored skill-creator: `LICENSE.txt` + `NOTICE.md` present with pinned upstream commit; loader exposes SKILL.md + agents/ + references/ verbatim (checksum test).
7. Builder preamble/modes: merged content includes the app-detection interview (recovered from OProject's create-mode) and dedup discipline; `buildSkillBuilderPrompt(mode, ctx?)` snapshot per mode.
8. KB teaches ONLY the new protocol: tests assert no ancestor tokens (ancestor hook names, `allow-same-origin`, `localStorage` as app storage) appear in rendered KB.
9. `pnpm --filter @snugprotocol/knowledge test` green; package builds; browser-safe loaders (content inlined at build via a codegen step or raw-imports; no runtime fs in exported API — node fs allowed only in the codegen/test layer).

**Out of scope**: serving prompts over HTTP (child 5); eval harness (next phase; layout must anticipate: prompts addressable by path).

## Plan

Workstreams (disjoint paths, delegated): (A) KB rewrite → `prompts/knowledge-base/app-authoring/` + `prompts/system/` + `prompts/tools/` + `prompts/ui/`; (B) skills → `prompts/skills/**` (vendor + merge preambles); (C) infra → `src/` loaders (codegen'd content module), section search, lint, goldens, header test. Tests-first for infra; content ACs enforced by the same tests. Integration: I verify cross-workstream consistency + run full suite + AI review.

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: task file; branch; workstreams delegated.
- Next: integrate, review, merge.
