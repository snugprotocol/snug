# Snug — Engineering Process (the six gates)

AI does the implementation, humans own intent, architecture, and verification — and every session leaves the shared memory (git + `docs/`) richer than it found it (**compound engineering**).

Working agreements on top: [conventions.md](../conventions.md) · [architecture.md](../architecture.md).

## The one rule

**No work happens outside a task file.** Every feature, bugfix, refactor gets a file in [`docs/tasks/active/`](../tasks/active/). The task file is the durable memory: spec, plan, decisions, session journal, next step. [next-steps.md](../next-steps.md) is the *queue*; the task file is the *workspace*.

## Gate 1 — Spec
Create the task file from [tasks/TEMPLATE.md](../tasks/TEMPLATE.md) (or `/start-task`). WHAT and WHY, acceptance criteria, out-of-scope, risk tier.

## Gate 2 — Plan
Read [architecture.md](../architecture.md), [code-map.md](../code-map.md), open ADRs, [lessons.md](../lessons.md), relevant [solutions/](../solutions/) **and the actual code**; write the plan INTO the task file: files to touch, test plan, cross-package impact, spec-sync implications (does this touch `packages/protocol` schemas? → [SPEC_SYNC.md](SPEC_SYNC.md)). Owner approves before implementation.

## Gate 3 — Tests first
Failing tests before implementation ([TDD.md](TDD.md)). One per acceptance criterion; regression test per bug; **negative tests for anything touching C1/C2** (e.g. an app envelope carrying an `Authorization` header must be stripped; an iframe with `allow-same-origin` must fail CI).

## Gate 4 — Implement
One branch per task — `feat/TASK-<id>` or `fix/TASK-<id>` off `main`. Small task-id-prefixed commits. Never commit to `main`; never commit secrets.

## Gate 5 — Verify and review
Run suites of every package touched **plus dependents** (graph in [architecture.md](../architecture.md); in doubt → `pnpm test` at root). AI review first, human second — diff AND task file.

## Gate 6 — Close the loop (never skip)
`/close-session`: journal entry → lessons → doc drift fixed in the same branch → ADR if a decision was made → **spec-changelog entry if `packages/protocol` changed** → commit everything. Merged & done → add one line to `tasks/done/INDEX.md` and delete the task file (ADR-0027; git history is the archive).

**Distill, don't only append (ADR-0027).** Memory the agent loads every session stays small: prune shipped/superseded `next-steps` items on every touch; merge or drop `lessons.md` rules that later work superseded; a superseding ADR updates the old ADR's status line in the same change. Git keeps every historical byte — the working tree keeps only what is currently true.

## Handoffs
`/handoff` then `/pickup <task-id>`. A handoff to future-you is still a handoff.

## Risk tiers

| Tier | Snug areas | Extra requirements |
|------|-----------|--------------------|
| **Low** | docs, `examples/`, Playground styling, marketing pages | Tests where practical; gates still apply |
| **Medium** | `packages/sdk`, `packages/db`, `packages/knowledge`, `packages/adapters`, `apps/server`, Playground logic | Full TDD + AI review + human review |
| **High** | `packages/protocol` (schemas = the public spec), `packages/runner` (sandbox/CSP), `packages/auth` (credential broker), anything touching C1/C2, npm publish config, CI/release workflows | Full TDD + negative tests + plan gets a fresh-context AI review **before implementation** + explicit self-sign-off in the journal |

Auto-escalate: touching a High-tier area at all makes the task High.

## Release & publish rules

- **Never** publish npm packages, deploy the Playground, push to `snugprotocol/spec`, or change repo visibility without an explicit human ask in that session.
- Every publish/deploy/spec-push is recorded in the task journal (what, when UTC, verification performed).
- Spec pushes additionally require a [spec-changelog](../spec-changelog.md) entry and follow [SPEC_SYNC.md](SPEC_SYNC.md).

## Conductor vs orchestrator
Conductor (interactive) for unfamiliar territory and all High-tier work; orchestrator (delegating) for well-specified Medium/Low. The gates are identical — **autonomy changes who types, not what gets verified.**

## Definition of Done
Spec + approved plan · tests first and green (touched + dependents) · docs/ADR/lessons/next-steps updated in-branch · spec-changelog updated if protocol changed · journal current · reviewed · merged via PR · task file in `done/`.
