---
description: Package current task state so a teammate (or future you) can take over
---

Hand off the current task. $ARGUMENTS

1. Append a `handoff` journal entry to the task file, written for a **cold reader**: done; half-done at file-level detail; test status per package; the **single next step**; watch-outs.
2. Verify `git status` clean on the task branch; journal anything uncommittable and why.
3. Commit the task-file update (task-id-prefixed).
4. Print a 5-line summary: task id, branch, state, next step, watch-outs. Resume with `/pickup <task-id>`.
