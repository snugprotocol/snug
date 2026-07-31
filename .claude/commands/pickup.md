---
description: Resume a task (yours or a teammate's) from its task file
---

Resume task: $ARGUMENTS

1. Find the task file in `docs/tasks/active/` (fuzzy-match; if ambiguous, list candidates). Read it fully — journal + recorded next step.
2. Check out the task branch. `git log --oneline main..HEAD`, `git diff main...HEAD --stat`, run the tests of every package the task lists as touched (`docs/engineering/TDD.md` table).
3. Restate: current state, last session's work, next step, test status — AND anything in the diff the journal does NOT explain (flag as lost context; journal it before continuing).
4. On confirmation, continue test-first, journaling as you go. Update **Owner** if taking over.
