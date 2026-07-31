# Architecture Decision Records (ADRs)

Append-only decision log for Snug. One file per decision: `NNNN-short-kebab-title.md`. Never rewrite or delete a past ADR — a reversal is a new ADR that supersedes it. Status: `accepted` · `superseded by NNNN` · `proposed`.

## Template

```markdown
# NNNN — <Title>

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Task:** TASK-YYYYMMDD-slug

## Context
## Decision
## Alternatives considered
## Consequences
```

## Index

- [0001 — Adopt the agentic engineering process](0001-adopt-agentic-engineering-process.md)
- [0002 — Two-repo topology: snug (master) drives spec (downstream)](0002-snug-master-spec-downstream.md)
- [0003 — v1 scope and hard security constraints inherited from prior production systems](0003-v1-scope-and-security-constraints.md)
