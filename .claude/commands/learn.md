---
description: Codebase learning session — understand an area and improve the written map
---

Learning session on: $ARGUMENTS

1. Start from the written map: `docs/architecture.md`, `docs/code-map.md`, `docs/glossary.md`, `docs/lessons.md`, relevant `docs/decisions/` + `docs/solutions/`.
2. Read the **actual code**. Where docs and code disagree, **code is truth** — note every drift.
3. Explain: entry points, data flow, key files with `file:line`, invariants (especially C1/C2 hard constraints), known defects, test coverage.
4. Close the loop: fix doc drift in a **docs-only commit**; landmines → `docs/lessons.md`; new terms → glossary.
