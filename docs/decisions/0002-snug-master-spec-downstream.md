# 0002 — Two-repo topology: snug (master) drives spec (downstream)

- **Status:** accepted
- **Date:** 2026-07-31
- **Task:** TASK-20260731-bootstrap

## Context
MCP-model org (`snugprotocol`) with a citable spec repo and a code monorepo. The owner wants ONE master repo carrying the agentic process, with the spec repo kept clean for public consumption.

## Decision
`snugprotocol/snug` is the master: all process files, task files, strategy docs, and the source-of-truth schemas (`packages/protocol`). `snugprotocol/spec` is a downstream publication: SPEC.md + schemas + whitepaper only, never edited directly, one traceable commit per spec change, driven by `docs/engineering/SPEC_SYNC.md` and logged in `docs/spec-changelog.md`.

## Alternatives considered
Process files in both repos (rejected: drift, duplication); spec as a folder inside the monorepo (rejected: loses independent citability and clean versioning); spec as master (rejected: spec-first invites bikeshedding; the implementation validates the spec).

## Consequences
Spec repo history stays clean and reviewable; all context concentrates where the work happens. Cost: a manual (later CI-checked) sync step, and pushes to spec require an explicit human ask.
