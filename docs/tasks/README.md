# Task registry

Every unit of work gets one file here, created from [TEMPLATE.md](TEMPLATE.md) (usually via `/start-task`). The task file is the durable memory: spec, plan, decisions, session journal, next step. Process: [engineering/PROCESS.md](../engineering/PROCESS.md).

- **`active/`** — in-flight tasks, journals current.
- **`done/`** — merged & finished, kept forever as searchable history.

Naming: `TASK-YYYYMMDD-short-slug.md` (start date); branch mirrors it: `feat/TASK-…` or `fix/TASK-…`.

[next-steps.md](../next-steps.md) is the queue; a task file is the workspace. ADRs record decisions surfaced during a task; lessons/solutions record what it taught us. **Tasks that change `packages/protocol` must plan and journal their spec-sync step** ([engineering/SPEC_SYNC.md](../engineering/SPEC_SYNC.md)).
