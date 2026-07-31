# 0001 — Adopt the agentic engineering process

- **Status:** accepted
- **Date:** 2026-07-31
- **Task:** TASK-20260731-bootstrap

## Context
New project adopting the process from day one, per the owner's BOOTSTRAP_AGENTIC_PROCESS.md. Solo founder + offshore engineers + multiple AI agents will work across sessions and machines; chat history is not durable memory.

## Decision
Six gates (Spec → Plan → Tests-first → Implement → Verify → Close-the-loop), one task file per work item in `docs/tasks/`, thin-pointer root AI files (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) with the wiki under `docs/` as source of truth, append-only ADRs and lessons.

## Alternatives considered
Ad-hoc agent sessions (rejected: state evaporates); heavyweight PM tooling (rejected: solo-founder overhead, memory should live in git next to code).

## Consequences
Process overhead per change in exchange for durable memory and safe multi-agent/multi-session work. Every session ends with `/close-session` — no exceptions.
