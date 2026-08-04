# TASK-20260803-schema-doc-tools: schema_apply + app_doc_write tools and compounding prompts (child 2 of living-apps)

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: medium (prompt store per ADR-0004; tool wiring in playground)
- **Branch**: `feat/TASK-20260803-living-apps` (umbrella branch)
- **Packages touched**: `knowledge`, `apps/playground` (tool wiring)
- **Spec impact**: none (prompts follow ADR-0004 store rules; no wire change — tools are host-side LLM tools, not frames)
- **Related**: umbrella [TASK-20260803-living-apps](TASK-20260803-living-apps.md), ADR-0004, ADR-0010, child 1 [TASK-20260803-userdb-v2](TASK-20260803-userdb-v2.md)

## Spec (what & why)

The LLM plans each app's data schema from its context/requirements/vision and maintains the app's wiki. Two new host-side tools: `schema_apply {statements: string[]}` (executed via child 1's `applyAppDdl` against the sink-pinned app) and `app_doc_write {slug, title?, content}` (docs CRUD, same pinning). Prompts updated: schema-first build guidance; **every turn that writes an app version must also update the relevant docs** (vision/requirements/plan seeded at first build; lessons/memory/plan deltas on change) — the compounding rule.

**Acceptance criteria** (umbrella AC3-part/AC7):
1. Tool definitions ship from the knowledge store (centralization lint green); playground executes `schema_apply` → `applyAppDdl` and `app_doc_write` → docs CRUD, both resolving the target through the artifact-sink pin (never an LLM-claimed app id).
2. Prompt content instructs: propose schema before writing app code; use natural table names via `useAppDB`; update docs on every app change (content tests).
3. First build seeds `vision`/`requirements`/`plan` docs; an enhance turn updates `lessons`/`plan` (mock-adapter integration test).
4. Knowledge lint, content-drift (`pnpm gen:content`), and KB≡SDK sync suites stay green.

**Out of scope**: context assembly (child 3), UI (children 3–4).

## Shared literals (from umbrella — verbatim)

Tool names `schema_apply` / `app_doc_write` · doc slugs `vision|requirements|plan|lessons|memory|next-tasks` · table-name rule `^[a-z][a-z0-9_]{0,40}$`.

## Plan

`packages/knowledge/prompts/tools/{schema-apply.md,app-doc-write.md}` + app-builder prompt amendments → loaders/assembly + lint → `apps/playground/src/agent/tools.ts` wiring + sink target resolution. Tests FIRST.

## Decisions & surprises

—

## Session journal (append-only, newest last)
