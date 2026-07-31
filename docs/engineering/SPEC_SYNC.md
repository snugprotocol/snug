# SPEC_SYNC — how this repo drives `snugprotocol/spec`

**This monorepo is the master.** The `spec` repo is a clean, human-readable publication of the protocol — no process files, no code, no churn. It is **never edited directly**; every change lands there from here.

## Source of truth
- Envelope message types + zod schemas: `packages/protocol/src/` (JSON Schema exported to `packages/protocol/schemas/`).
- Spec prose: drafted here in the task that motivates the change, then written into the spec repo's `SPEC.md`.

## The flow (every protocol change)
1. Task file in this repo (High tier — `packages/protocol` is High).
2. Gate 2 plan states the spec impact: message(s) added/changed, version bump (spec versions are `v0.x` pre-1.0, independent of npm package versions), migration notes.
3. Implement schema + code + tests here; regenerate `packages/protocol/schemas/*.json`.
4. Prepare the spec repo change in a local clone of `snugprotocol/spec`: update `SPEC.md`, copy regenerated schemas into `spec/schemas/`, bump the version header.
5. **Explicit human ask required to push to `snugprotocol/spec`** (see PROCESS.md release rules). Push as a single commit: `spec vX.Y: <summary> (from snug TASK-<id>)`.
6. Append an entry to [`docs/spec-changelog.md`](../spec-changelog.md): date, spec version, task id, summary, spec-repo commit SHA.

## Invariants
- Spec repo history = one commit per spec change, each traceable to a task here.
- Schemas in the spec repo are byte-identical to `packages/protocol/schemas/` at the referenced commit (CI check to be added: `scripts/check-spec-sync`).
- Anything in the spec repo not explained by the changelog is drift — fix by re-publishing from here.
