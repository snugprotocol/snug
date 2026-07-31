# Snug — Prompt Templates

Short copy-paste prompts per workflow stage. The slash commands in `.claude/commands/` automate these; templates are for manual steering or non-Claude tools.

## Start a task (Gate 1–2)
```
/start-task <short description>
```
or manually:
```
New task: <what and why, 2–5 sentences>.
Acceptance criteria: <list>. Out of scope: <list>.
Create the task file in docs/tasks/active/ from docs/tasks/TEMPLATE.md, read
docs/architecture.md + docs/code-map.md + docs/lessons.md + relevant docs/decisions/
and the actual code, write the plan into the task file (note spec-sync impact if
packages/protocol is touched), create the branch, and STOP for my approval.
```

## Approve the plan → implement (Gate 3–4)
```
Plan approved. Proceed test-first per docs/engineering/TDD.md: show me the failing
tests before implementation, small task-id-prefixed commits, journal as you go.
```

## Resume (any gate)
```
/pickup <task-id or fuzzy name>
```

## Verify (Gate 5)
```
Run the suites of every package this task touched plus their dependents
(docs/architecture.md dependency graph; in doubt run `pnpm test`).
Then AI code review. Report failures verbatim — do not fix in the same breath.
```

## Hand off / end session / record a decision
```
/handoff        /close-session        /adr <one-line decision>
```
