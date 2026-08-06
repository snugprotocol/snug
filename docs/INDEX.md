# Snug — Wiki Index

> **This is the hub.** `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` all point here. All durable project knowledge lives under `docs/`. Load only the page a task needs — that keeps the context window lean (progressive disclosure).

---

## ⛔ Always read first — Hard Constraints

- **C1 — Token boundary.** Credentials/tokens never enter the app iframe, never reach the LLM, never reach a publisher. Host-bound injection always strict.
- **C2 — Sandbox integrity.** `allow-scripts` only, `connect-src` blocked, fixed CDN allowlist. Never weakened.
- **C3 — Protocol changes flow through spec-sync.** `packages/protocol` schemas are source of truth; `snugprotocol/spec` is downstream. See [engineering/SPEC_SYNC.md](engineering/SPEC_SYNC.md).
- **C4 — `internal/` never ships public.** Strip before flip-public (`internal/LAUNCH_OPS.md` checklist).
- **C5 — Security is first-class.** Secrets via env in `apps/server` only; validate all input at the envelope boundary.

## 🧠 Always read first — Code-generation personas

| Language | Embody | Standard |
|----------|--------|----------|
| **TypeScript** | Anders Hejlsberg league; front-end: Evan You / Rich Harris | [standards/typescript.md](standards/typescript.md) |

Optimize for **clarity and maintainability** over cleverness.

---

## Start here

| Page | What it is | Load when |
|------|-----------|-----------|
| [product-vision.md](product-vision.md) | What Snug is, differentiators, v1 scope, roadmap | Any product/scope call |
| [architecture.md](architecture.md) | Current architecture + dependency graph | Designing or changing structure |
| [code-map.md](code-map.md) | "Where does X live" across the repo | Finding the right file to touch |

## Working agreements

| Page | What it is | Load when |
|------|-----------|-----------|
| [conventions.md](conventions.md) | Hard constraints, code style, deps policy, security, testing, memory hygiene | Before writing or reviewing any code |
| [engineering/PROCESS.md](engineering/PROCESS.md) | **The six-gate process** — task files, risk tiers, release rules, Definition of Done | Starting, resuming, or closing any work |
| [engineering/TDD.md](engineering/TDD.md) | Test-first policy + test command table | Before writing tests/implementation |
| [engineering/SPEC_SYNC.md](engineering/SPEC_SYNC.md) | **How this repo drives the `spec` repo** | Any protocol/schema change |
| [engineering/PROMPT_TEMPLATES.md](engineering/PROMPT_TEMPLATES.md) | Copy-paste prompts per workflow stage | Steering an agent manually |
| [`packages/knowledge/prompts/README.md`](../packages/knowledge/prompts/README.md) | **The layered prompt store** (ADR-0004): tree, layers, placeholder rules, goldens — plus the external prompt-engineering references | Authoring or changing any LLM-bound prompt |
| [tasks/](tasks/README.md) | **Task registry** — one file per work item | Any work session (`/start-task`, `/pickup`) |

## Living state

| Page | What it is | Load when |
|------|-----------|-----------|
| [next-steps.md](next-steps.md) | Dated, ordered backlog | Picking up work / checking what's next |
| [spec-changelog.md](spec-changelog.md) | Every change pushed to `snugprotocol/spec`, with task id | Any protocol change; preparing a spec release |
| [decisions/](decisions/README.md) | Append-only ADRs | Understanding *why* |
| [lessons.md](lessons.md) | Append-only rules learned the hard way | **Always at Gate 2**; append at Gate 6 |
| [glossary.md](glossary.md) | Domain terms (envelope, bridge, micro app…) | Meeting an unfamiliar term |
| [good-first-issues.md](good-first-issues.md) | Curated contributor entry points, mirrored on the `good first issue` label | Community/contributor work; keep true when fixing a listed item |
| [solutions/](solutions/) · [runbooks/](runbooks/) | Root-cause write-ups · ops how-tos | As needed |

## Pre-launch strategy (private)

`../internal/` — full strategy, market audits, launch operations. **Never ships public (C4).** Load when making launch/positioning/priority calls.

---

## Memory hygiene

- **Edit the wiki, not the root files** ([conventions.md](conventions.md#sync-rule)).
- **Decisions are append-only.** New ADR per decision.
- **next-steps is dated.** Append with a date; prune stale items.
- **Amend conventions/standards in the same change** that motivates them.
