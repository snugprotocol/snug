# 0004 — Central layered prompt store in `packages/knowledge/prompts/`

- **Status:** accepted (with TASK-20260731-build-hub plan approval; shipped in packages/knowledge/prompts/)
- **Date:** 2026-07-31
- **Task:** TASK-20260731-build-hub

## Context

The 2026-07-31 survey of both ancestor systems (private prompt/UI survey, C4) found ~80 prompt artifacts spread across TS string constants, route-handler string appends, versioned `.md` asset folders, DB-seeded rows, S3-seeded templates, boot-time GitHub fetches, and client-side React components — with at least three near-duplicate assembly implementations and a 4-way duplicated envelope-tag literal. One of them later externalized its system prompt into a versioned template folder (validating the direction); the other recorded an explicit anti-generic-loader doctrine ("each template gets its OWN typed export, NOT a hashmap"). A prompt-eval harness is the next phase and needs prompts addressable by stable path.

## Decision

All LLM-bound prompt content lives in `packages/knowledge/prompts/` — layered subfolders mirroring assembly order (`system/` numbered by injection order, `knowledge-base/`, `tools/`, `skills/`, `templates/`, `ui/`). Every file carries a mandatory header comment (layer, destination, blast-radius, provenance). Content is centralized, but the **API stays typed per layer** (honoring the source system's doctrine — no generic string-keyed loader): each layer is a typed export from `packages/knowledge/src`, with protocol constants (envelope tag, message types) template-injected from `packages/protocol` at load time, never retyped. Tenant/user-specific prompts exist in the repo **only as `{{placeholder}}` templates**; instance data stays runtime data rendered through them. Enforced by: a repo-level centralization lint (fails on LLM-bound literals outside the store or files missing headers), and golden assembly snapshots per pipeline so any edit shows its blast radius in the diff. Versioning/rollback = git.

## Alternatives considered

Top-level `prompts/` dir (more discoverable, but splits content from its loader and complicates npm publishing); status quo scatter (rejected — it is the disease being cured); DB/S3-resident prompts with admin UI (rejected for v1: kills git versioning/review, reintroduces the source systems' seeding drift).

## Consequences

Prompt edits become reviewable diffs with visible blast radius; the eval harness (next phase) addresses prompts by path; contributors and agents find every prompt in one README-mapped tree. Cost: KB markdown heading structure is retrieval-load-bearing and header comments are mandatory — casual reformatting breaks behavior, so the lint and goldens must land with the store, not after.
