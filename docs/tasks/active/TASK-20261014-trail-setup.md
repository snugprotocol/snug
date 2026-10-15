# TASK-20261014-trail-setup: Wire trail (code map + agent memory) into the repo for Claude Code

- **Status**: done (local-only setup verified; cleanups applied; closed 2026-10-14)
- **Owner**: Jeetu
- **Risk tier**: low (dev tooling only; no package code, no CI/release config, no C1/C2 surface). Rises to a review-worthy low if the wiring is committed (see Q1).
- **Branch**: `feat/TASK-20261014-trail-setup`
- **Packages touched**: none (repo-root tooling files only)
- **Spec impact**: none
- **Related**: owner request 2026-10-14; ADR-0057 / `check-public-scrub` (anything committed must survive the public flip)

## Spec (what & why)

Install [trail](https://github.com/trailhq/Trail-Code) for this repo: a prebuilt symbol/call graph (`graft/`) plus MCP tools and Claude Code hooks, so sessions find code with `trail_find_code` / `trail_trace_calls` instead of many file reads. The owner asked for exactly three commands, in order: `trail init --agents claude`, `trail telemetry disable`, `trail build`.

Verified before planning (2026-10-14):
- Binary: `/Users/jeetu/.nvm/versions/node/v24.16.0/bin/trail` → `@trailhq/trail-code@0.22.0`, MIT, `repository` = `github.com/trailhq/Trail-Code` (matches the URL the owner gave). Has a `postinstall` script (already run at global install).
- Telemetry status is **already off** ("you disabled it"); 13 events sit queued locally. Endpoint `events.nanonets.com`.
- User-level wiring **already exists** from an earlier install: `~/.claude/settings.json` hooks → `~/.claude/helpers/graft-hooks.cjs` (SessionStart / UserPromptSubmit / PostToolUse / Stop) and `mcpServers.trail` in `~/.claude.json`.
- `trail init --agents claude --dry-run` would write:
  - repo: `.claude/settings.json` (new — statusline + hook blocks), `.claude/helpers/trail-statusline.cjs`, `.claude/helpers/trail-hooks.cjs`, `.claude/skills/trail/SKILL.md`, `.mcp.json` (`mcpServers.trail`)
  - machine (all repos): `~/.claude/helpers/graft-hooks.cjs`, `~/.claude/settings.json`, `~/.claude.json` — a refresh of what is already there
- `trail build` writes `graft/`, appends `graft/` to `.gitignore` (tracked file), and writes `.ignore` (ripgrep re-admit). Plain build is local, `$0`, no API key; `--deep` (LLM pass) is NOT requested.
- None of the repo-level paths is currently gitignored → all would appear as untracked changes.

**Acceptance criteria** (verified by command, not unit tests — no package code changes):
1. `trail status` reports a built code map for this repo.
2. `trail build --check` exits 0 (graph not stale).
3. `trail telemetry` reports `off`.
4. A trail MCP query (`trail ask "credential broker"` or `trail_find_code`) returns ranked hits from `packages/`.
5. `git status` matches the Q1 decision exactly: either only the intended files appear as changes (commit path) or the tree is clean (local-only path).
6. No change to `~/.claude/settings.json` beyond trail's own hook/MCP blocks (diff the backup taken in step 0).

**Out of scope**: `trail build --deep` (sends code to an LLM provider), other agents (cursor, gemini, codex, …), CI `trail build --check` / `trail blast` jobs, `trail note` team-memory workflow in `.trail/`.

## Plan

0. Back up `~/.claude/settings.json` and `~/.claude.json` to the scratchpad (rollback + AC6 diff).
1. `trail telemetry disable` **first** (reordered from the owner's list so no init/build event is ever queued while the state is in doubt; it is already off, so this is belt-and-braces and order-independent otherwise).
2. `trail init --agents claude --no-build` (+ `--no-global` if Q2 says so). `--no-build` because step 3 builds explicitly.
3. `trail build` (+ `--no-gitignore --no-ignore` on the local-only path, so the tracked `.gitignore` stays untouched).
4. Local-only path: add the trail paths (`graft/`, `.trail/`, `.ignore`, `.mcp.json`, `.claude/settings.json`, `.claude/helpers/`, `.claude/skills/trail/`) to `.git/info/exclude` — untracked by git, no repo diff.
   Commit path: review each file for absolute paths / machine specifics (the shims reference `node` + repo paths), run `check-public-scrub`, commit with the task id, keep `graft/` ignored.
5. Verify AC1–6; journal; `/close-session`.

Rollback: `trail uninstall` removes everything trail wrote to the repo; restore the two home-dir files from step 0.

## Decisions & surprises

- The global wiring predates this task — so does a disabled-telemetry state, meaning trail has been installed and configured on this machine before.
- **Q1 → local only** (owner, 2026-10-14). Trail paths listed in `.git/info/exclude`; built with `--no-gitignore --no-ignore`; the tracked tree is unchanged. **Q2 → global refresh allowed**; the refresh turned out a no-op (`~/.claude/settings.json`, `~/.claude.json`, `graft-hooks.cjs` byte-identical to the backups).
- **Surprise — init reads session transcripts.** `trail init` printed "reading your 7 past Claude sessions here for what you keep telling Claude"; `--dry-run` did not mention it. It wrote only `.trail/README.md` (no learnings). Telemetry was off throughout; no API key was configured.
- **Surprise — permissions allowlist.** The project `.claude/settings.json` auto-allows `Bash(trail:*)`, `Bash(graft:*)`, `Bash(npx graft:*)`, `Bash(graft-dev:*)`, `Bash(node dist/cli.js:*)`. `npx graft` would fetch whatever npm `graft` resolves to if not installed locally; `node dist/cli.js` auto-approves any such script. Left as written (owner to decide).
- **Surprise — hooks fire twice here.** The user-level `graft-hooks.cjs` and the project-level `trail-hooks.cjs` are byte-identical and both registered on SessionStart / UserPromptSubmit / PostToolUse / Stop; no dedupe logic in the shim. Same for the MCP server (`~/.claude.json` and `.mcp.json` both register `trail`). Not fixed (owner to decide).

## Session journal (append-only, newest last)

### 2026-10-14 — Jeetu / Claude (Opus 5.5) — session
- Done: verified package provenance, dry-run of `init`, inspected existing global wiring and gitignore coverage; task file + branch.
- State: planned, awaiting owner answers + plan approval. Nothing written by trail yet.
- Next step: owner answers Q1/Q2 → run steps 0–5.
- Open questions: Q1, Q2 (above).

### 2026-10-14 — Jeetu / Claude (Opus 5.5) — session (implementation)
- Owner answers: Q1 local only, Q2 allow refresh, plan approved.
- Done: step 0 backups (scratchpad) → `trail telemetry disable` → `trail init --agents claude --no-build` → exclude list → `trail build --no-gitignore --no-ignore` (1338 files, 11,610 nodes, 32,474 edges, 19 s, no cache).
- Verified: AC1 `trail status` "in sync with the code" · AC2 `trail build --check` exit 0 · AC3 telemetry off · AC4 `trail ask "credential broker host-bound injection"` → hits in `packages/auth`, `packages/db`, `packages/protocol` · AC5 `git status` shows only this task file · AC6 home-dir config byte-identical to backups.
- State: trail live for this repo; a Claude Code restart loads the project `.mcp.json` + hooks.
- Next step: owner decides (a) trim the `npx graft` / `node dist/cli.js` allow entries, (b) drop the project-level hooks/MCP duplicates; then `/close-session` (done/INDEX line, delete this file, PR).
- Open questions: (a), (b).

### 2026-10-14 — Jeetu / Claude (Opus 5.5) — session close
- Owner: "yes go ahead with two cleanups", then close, push, PR, merge once CI is green.
- Done: (a) removed `Bash(npx graft:*)` and `Bash(node dist/cli.js:*)` from the project `.claude/settings.json`; (b) removed its `hooks` block and deleted `.mcp.json` — the user-level hooks and `mcpServers.trail` in `~/.claude.json` still cover this repo; the statusline stays (no user-level one). Pre-cleanup copies in the session scratchpad. `trail status` in sync; `trail build --check` exit 0.
- **Surprise — `.gitignore` written anyway.** After the build, the user-level post-edit hook refreshed the graph on the next file edit and appended `/graft/` to the tracked `.gitignore` (`--no-gitignore` is not persisted). Reverted; added `env: { GRAFT_NO_GITIGNORE: "1", GRAFT_NO_IGNORE: "1" }` to the gitignored `.claude/settings.local.json` (effective from the next session). Lesson filed in `docs/lessons.md` (storage, config & mechanical edits).
- Local machine state this task leaves (nothing committed): trail paths in `.git/info/exclude`; `graft/` built; project `.claude/settings.json` (statusline + trail allows), `.claude/helpers/trail-*.cjs`, `.claude/skills/trail/`, `.trail/README.md`; the env block above. Undo: `trail uninstall`, then remove the exclude block and the env entries. Re-running `trail init` re-adds the hooks, `.mcp.json` and allow entries — trim again.
- Docs: no architecture / code-map / conventions / next-steps drift (local dev tooling, no repo code); no ADR (a per-machine tool choice, reversible, nothing committed); no protocol change.
- State: done. Closed in the same PR (done line + task file deleted, ADR-0027).
- Next step: none.
- Open questions: none.
