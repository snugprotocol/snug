You are Codex working on **Snug (the Snug Protocol)**. This is the config Codex reads. This file is intentionally lite; the wiki under `docs/` is the source of truth.

<!-- ===== Shared body (identical in CLAUDE.md / AGENTS.md / GEMINI.md) ===== -->

All durable knowledge lives in **`docs/`**. **Start at [`docs/INDEX.md`](docs/INDEX.md)** and load only the page a task needs (progressive disclosure — keeps context lean).

**Hard constraints (non-negotiable):**
- **C1 — Token boundary.** Credentials/tokens never enter the app iframe, never reach the LLM, never reach a publisher. Host-bound credential injection is always strict — no bypass flags.
- **C2 — Sandbox integrity.** App iframes run `sandbox="allow-scripts"` only, `connect-src` blocked, CDN allowlist fixed. Never weaken these, even for a demo.
- **C3 — Protocol changes flow through spec-sync.** `packages/protocol` schemas are the source of truth; every change follows [`docs/engineering/SPEC_SYNC.md`](docs/engineering/SPEC_SYNC.md) and is recorded in [`docs/spec-changelog.md`](docs/spec-changelog.md). The `snugprotocol/spec` repo is downstream — never edited directly.
- **C4 — `internal/` never ships public.** It holds pre-launch strategy and must be removed (or moved to a private repo) before this repo is flipped public. The flip-public checklist lives in `internal/LAUNCH_OPS.md`.
- **C5 — Security is first-class.** Secrets via environment variables in `apps/server` only; no secrets in packages, logs, config, or source. Validate all input at the envelope boundary.

**Source systems.** Extraction work draws on two prior production systems, referred to throughout by the codenames **OProject** and **IProject**. Their real names, local paths, and branches live in `internal/.env.local` (gitignored — never commit or quote them in tracked files). Read that file before any extraction, port, or audit task; the trees sit outside this repo, so reading them needs cross-directory access.

**When generating code, adopt the language-expert persona and follow the matching standard:**
- **TypeScript** → Anders Hejlsberg league; front-end → Evan You / Rich Harris league — [`docs/standards/typescript.md`](docs/standards/typescript.md)

Optimize for clarity and maintainability over cleverness. **Update the wiki as part of normal work** (decisions are append-only; next-steps is dated). Keep this file and its siblings (`AGENTS.md`, `GEMINI.md`) in sync — prefer editing `docs/` only; see [`docs/conventions.md`](docs/conventions.md#sync-rule).

**Process (non-negotiable — [`docs/engineering/PROCESS.md`](docs/engineering/PROCESS.md)):**
1. All work follows the six gates; **no work outside a task file** (`docs/tasks/active/`) — start with `/start-task`, resume with `/pickup`, **always** end the session with `/close-session`.
2. Test-first for Medium/High risk tiers ([`docs/engineering/TDD.md`](docs/engineering/TDD.md)); never delete or weaken a failing test to get green.
3. Never commit or push directly to `main` — branch `feat|fix/TASK-<id>`, PR, review (AI first, human second).
4. **Never publish npm packages, deploy the Playground, push to `snugprotocol/spec`, or flip a repo public without an explicit human ask in that session.**
5. **Memory is git — if state exists only in a chat, it doesn't exist.**

Slash commands (Claude Code): `/start-task` · `/pickup` · `/handoff` · `/close-session` · `/adr` · `/learn`. Other tools follow the same gates manually via [`docs/engineering/PROMPT_TEMPLATES.md`](docs/engineering/PROMPT_TEMPLATES.md).
