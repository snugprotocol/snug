---
description: Start a new task — spec, task file, plan, stop for approval
---

Start a new task for: $ARGUMENTS

Follow `docs/engineering/PROCESS.md` (Gates 1–2):

1. Create `docs/tasks/active/TASK-<YYYYMMDD>-<short-slug>.md` from `docs/tasks/TEMPLATE.md`.
2. Interview the developer — 2–5 batched questions — to pin down: behavior, acceptance criteria (each becomes a test), out-of-scope, risk tier. **Auto-escalate to High** if the task touches: `packages/protocol` schemas, `packages/runner` sandbox/CSP, `packages/auth`, anything affecting hard constraints C1/C2, npm publish or CI/release config. Widely-depended packages (`protocol`, `db`) default to at least Medium.
3. Read `docs/architecture.md` (incl. dependency graph), `docs/code-map.md`, `docs/lessons.md`, relevant `docs/decisions/` + `docs/solutions/`, and the actual code. Write the plan INTO the task file: files to touch, order, cross-package impact, test plan (tests FIRST per `docs/engineering/TDD.md`), **spec-sync impact** (`docs/engineering/SPEC_SYNC.md`) if protocol is touched. Draft an ADR now if a decision is being made.
4. Create branch `feat/TASK-<id>` (or `fix/`) off `main`; record it in the task file.
5. **STOP for plan approval before any implementation code.**
