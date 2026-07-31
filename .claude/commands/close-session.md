---
description: End-of-session memory update (Gate 6) — run every session
---

Close this session per `docs/engineering/PROCESS.md` Gate 6. All steps — none optional. $ARGUMENTS

1. **Journal**: append a session entry to the task file (done / exact state / single next step / open questions). No task file? Say why; if code changed, create one retroactively.
2. **Lessons**: surprises, wrong assumptions, bug patterns, landmines → `docs/lessons.md` (deep write-ups → `docs/solutions/`). None? State "no lessons" explicitly.
3. **Docs**: fix drift — architecture, code-map, conventions, glossary, next-steps (dated) — in the same branch. ADR if a decision was made. **If `packages/protocol` changed: spec-changelog entry + spec-sync plan.** Honor the root-file sync rule.
4. **Commit**: show `git status`, commit everything (task-id-prefixed). Merged & finished → move task file to `done/`.
5. End by stating: **"Nothing about this session's state exists only in this chat."** — and make it true first.
