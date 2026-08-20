---
description: End-of-session memory update (Gate 6) — gate, document, PR, merge
model: claude-opus-5
---

Close this session per `docs/engineering/PROCESS.md` Gate 6. All steps — none optional. $ARGUMENTS

**Why `model:` is pinned.** This command merges to `main` on the strength of its own
judgement about whether a gate passed and what the docs should say. It runs on Opus 5
regardless of the session model (the override lasts this turn only and does not change
your session setting).

---

## Step 0 — Choose the gate legs, then run them

GitHub Actions is dormant (billing-blocked; see `.github/workflows/ci.yml`), and this repo
has no branch protection — private on a free org plan, so required status checks were never
available. **`pnpm run gate:local` is the only thing between this commit and `main`.**

First run `pnpm run gate:local --list` to show the legs, then **ASK the user which to run**,
using the AskUserQuestion tool with a multi-select and these defaults:

- `workspace` — **checked** (build + all package tests + threat-model + sandbox guard, ~2 min)
- `smoke` — **checked** (server boot + CSP header, ~10 s)
- `e2e` — unchecked (Playwright, ~6 min)
- `rust` — unchecked (cargo test, ~1 min)
- `desktop` — unchecked (package tests + in-shell WKWebView gate, ~5 min)
- `release` — unchecked (release-inertness proof, ~5 min)

Offer "everything (`--all`, ~15–20 min)" as a choice too. Recommend legs that match the
diff: touched `apps/desktop` → suggest `desktop` + `rust`; touched `packages/runner`,
`packages/auth`, or the playground UI → suggest `e2e`.

Then run `pnpm run gate:local --legs=<selection>` (or `--all`).

**If the gate fails: STOP.** Report which leg failed and why. Write nothing, commit
nothing, open no PR, merge nothing. A red gate ends the session — the fix is its own work.

**If the gate passes**, carry its verdict line forward verbatim; it names any leg that was
NOT verified, and that disclosure belongs in both the journal and the PR body.

---

## Step 1 — Journal

Append a session entry to the task file: done / exact state / single next step / open
questions. Include the gate verdict, **including the deselected legs**. No task file? Say
why; if code changed, create one retroactively.

## Step 2 — Lessons

Surprises, wrong assumptions, bug patterns, landmines → `docs/lessons.md` (deep write-ups →
`docs/solutions/`). None? State "no lessons" explicitly.

## Step 3 — Docs

Fix drift — architecture, code-map, conventions, glossary, next-steps (dated) — in the same
branch. ADR if a decision was made. **If `packages/protocol` changed: spec-changelog entry +
spec-sync plan.** Honor the root-file sync rule (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`).

## Step 4 — Retire the task file, then commit

If this task is finished and about to merge: add one line to `docs/tasks/done/INDEX.md` and
delete the task file (ADR-0027; git history keeps the full text). This has to happen BEFORE
the commit — a task file retired after the merge would need a second PR to land.

Not finished? Leave the task file in `active/` and say so in the journal.

Then show `git status` and commit everything (task-id-prefixed).

## Step 5 — Push and open the PR

Push the branch. If no PR exists for it, open one. The PR body carries the gate verdict
verbatim — including the NOT VERIFIED line when the run was partial, so the durable record
shows which evidence backed this merge.

## Step 6 — Merge

Merge the PR (squash). **No confirmation is required** — owner decision 2026-08-20: the leg
selection in step 0 IS the human beat, and it deliberately sits before the work rather than
after it.

Refuse to merge only if the gate did not pass, or if the merge itself errors (conflict,
protected branch, network). Report any such refusal plainly rather than retrying blindly.

## Step 7 — Return to main

`git switch main`, then `git pull` (fetch + fast-forward). Confirm the merge landed and the
tree is clean.

---

End by stating: **"Nothing about this session's state exists only in this chat."** — and
make it true first.
