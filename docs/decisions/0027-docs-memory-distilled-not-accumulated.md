# 0027 — Docs memory is distilled, not accumulated

- **Status:** accepted (plan approved by owner 2026-08-15)
- **Date:** 2026-08-15
- **Task:** TASK-20260815-docs-context-cleanup

## Context

The compound-engineering memory grew write-only for six weeks: `tasks/done/` reached 53 files (~1.2MB), `lessons.md` 76KB and `next-steps.md` 100KB — both loaded routinely at Gate 2 (~19k/~25k tokens per session). Entries superseded by later decisions (ADR-0017/0024/0025/0026 reversals, removed surfaces) still read as current guidance, so agents plan against dead decisions. Git already preserves every historical byte; keeping full text in the working tree buys nothing and costs every session.

## Decision

The working tree holds only **currently-true, currently-useful** memory; git history is the archive.

1. **Done tasks compact to an index.** On merge, the task file's durable facts (id, title, PR, ADRs, key outcome) go to one line in `tasks/done/INDEX.md`; the file itself is deleted. Full text stays reachable via git history.
2. **`lessons.md` is distilled, not only appended.** Rules superseded by code or ADRs are dropped; overlapping rules merge. Distillation is a normal Gate 6 act.
3. **`next-steps.md` prunes on every touch.** Shipped and superseded entries are removed, not ✅-annotated forever.
4. **ADR files are still never deleted or rewritten** — but a supersession updates the old ADR's status line to `superseded by NNNN` in the same change.
5. Session auto-memory follows the same rule: current-state facts, consolidated; no merged-work journaling.

## Alternatives considered

- **Keep everything, load selectively** — rejected: the process mandates loading lessons/next-steps at Gate 2, and agents can't know an entry is dead without the audit this ADR makes routine.
- **Summarize done tasks in place (53 stub files)** — rejected: file-count noise remains; the index gives the same recall hook in one page.

## Consequences

- Reverses `tasks/README.md` "kept forever as searchable history" (search moves to `git log`/`git show`).
- `PROCESS.md` Gate 6, `tasks/README.md`, and `INDEX.md` memory-hygiene are amended in the same task.
- Recovering old detail now requires git (`git show <sha> -- docs/tasks/done/<file>`); the INDEX line carries the id needed to find it.
