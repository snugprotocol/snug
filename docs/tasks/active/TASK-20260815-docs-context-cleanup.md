# TASK-20260815-docs-context-cleanup: Prune stale/conflicting docs and memory to cut per-session context cost

- **Status**: planned (awaiting owner approval)
- **Owner**: Jeetu
- **Risk tier**: low (docs-only; no package code touched — but process-bearing files, so plan approval required before any deletion)
- **Branch**: `chore/TASK-20260815-docs-context-cleanup` (to be created after plan approval)
- **Packages touched**: none (docs/, internal/, plus session memory outside the repo — see interview)
- **Spec impact**: none
- **Related**: PROCESS.md Gate 6 (memory hygiene), INDEX.md "Memory hygiene" section, all ADRs (status audit), auto-memory dir

## Spec (what & why)

The agentic-engineering memory (docs/, task files, lessons, next-steps, ADRs, session auto-memory) has grown faster than it has been pruned. Token usage per session is up because routinely-loaded files are bloated: `lessons.md` ~76KB and `next-steps.md` ~100KB (~19k/~25k tokens, both loaded at Gate 2 / work pickup), 11 files in `tasks/active/` of which most describe already-merged work, 53 done-task files (~1.2MB), and 27 ADRs with no superseded/current status marking. Some guidance is now conflicting (earlier "A" decisions later replaced by "B"). Goal: audit every doc against the **current codebase** and the go-forward vision, then delete/condense/mark-superseded so each routinely-loaded file is small and every surviving statement is currently true.

**Acceptance criteria** (verification checks, not unit tests — docs-only task):
1. `docs/tasks/active/` contains only genuinely in-flight tasks; every merged task's file is out of `active/`.
2. `lessons.md` and `next-steps.md` are each reduced to only currently-valid entries (target ≥60% size reduction), with nothing contradicting the current code or ADRs.
3. Every ADR has an explicit status line (accepted | superseded-by-NNNN); no ADR deleted (append-only preserved).
4. Auto-memory (`MEMORY.md` + memory files) contains no entry contradicting merged state; stale entries deleted or merged.
5. `code-map.md` / `architecture.md` spot-checked against the real tree; drifted sections fixed or removed.
6. A grep for known replaced-decision keywords (collected during audit) returns no hits outside ADR history and `spec-changelog.md`.
7. `pnpm test` at root still green (no code touched — sanity check only).

**Out of scope**: `packages/knowledge` prompt store (functional asset, not notes); `spec-changelog.md` (append-only ledger required by C3); `docs/security/` threat models; whitepaper; the `spec` repo; any behavior/code change.

### Interview outcomes (owner, 2026-08-15)

1. **done/ tasks** → delete files, keep a one-line-per-task `done/INDEX.md` (id, title, PR, key outcome); git history is the archive.
2. **Append-only surfaces** → `lessons.md` rewritten/distilled to currently-valid rules (old text lives in git); ADR files never deleted, but every file gets a correct status line (`accepted` / `superseded by NNNN`).
3. **Scope beyond docs/** → ALL of: auto-memory dir, global `~/.claude/CLAUDE.md`, `internal/` (superseded material only), stale local git branches.
4. **Active tasks** → consolidate: merged tasks leave `active/`; every still-open thread (owner manual tests AL-10/11/12/15, any unlanded fix, held items) is extracted into `next-steps.md`; `active/` ends with only this task.

## Plan

**Approach:** audit against ground truth (code + `git log main`), never against memory or task-file claims — the recon already caught stale memory (the app-reply fix that memory calls "unpushed" appears merged as PR #40). Every deletion is either (a) recoverable from git history or (b) preceded by a backup (for the two non-git surfaces). Heavy per-entry reading is delegated to parallel read-only subagents so the audit itself doesn't burn main-session context.

**Phase 0 — process amendment (the decision itself)**
- Draft **ADR-0027 — Docs memory is distilled, not accumulated** (status `proposed` until owner approves this plan): done tasks compact to an index; `lessons.md` is periodically distilled (git keeps the archive); `next-steps.md` prunes on every touch; ADR statuses are maintained on supersession. Reverses `tasks/README.md` "kept forever" and softens "lessons append-only".
- Amend in the same branch: `tasks/README.md`, `engineering/PROCESS.md` Gate 6, `INDEX.md` memory-hygiene section — so the bloat cannot silently regrow.

**Phase 1 — audit (read-only, parallel subagents; verdicts land in this file)**
- *Active tasks (11 files):* per-file merge-state check against `git log main`; harvest every open thread into a consolidation list. Known specials: `logo-variants` (no commits on main — likely never started; verdict from content), `alpha-umbrella` (holds owner tests AL-10/11/12/15), `app-reply-parse-failure` (verify AC2/AC4 state vs PR #40).
- *lessons.md (192 entries-ish):* verdict per entry — keep / merge-into-rule / drop (superseded by later ADR or removed feature).
- *next-steps.md (173 lines, 98 long ones):* verdict per entry — still-open / shipped (✅ or listed in a merged task) / superseded.
- *ADR cross-refs (27):* build the supersession map (e.g. 0017 amends 0016; 0024/0025/0026 vs earlier auth/UI decisions), fix each file's status line only.
- *code-map.md + architecture.md:* drift check against the real tree (packages list, dependency graph, file pointers).
- *internal/ + auto-memory (18 files):* staleness verdicts; memory files consolidate into few current-state facts.

**Phase 2 — repo writes (order matters, one concern per commit)**
1. `done/INDEX.md` written (one line per task incl. the 53 existing + newly moved ones) → delete `done/*.md` task files.
2. Active consolidation: open threads → `next-steps.md`; merged/stale active files get a closing journal line → moved to the index (not to `done/` as files); `active/` keeps only this task.
3. `next-steps.md` rewritten: only currently-open items, dated, ordered; target ≤10KB.
4. `lessons.md` distilled: currently-valid rules grouped by theme, each ≤5 lines; target ≤15KB.
5. ADR status lines fixed per the supersession map; `decisions/README.md` index annotated.
6. `code-map.md`/`architecture.md` drift fixes (edits only where audit found drift).
7. `internal/`: superseded audit docs get a one-line SUPERSEDED banner pointing at what replaced them (C4 — nothing leaves `internal/`); no deletions here without per-file owner sign-off at review.

**Phase 3 — non-git surfaces (after PR opens; backups first)**
- Auto-memory dir: copy to `<memory>/backup-20260815/` → rewrite `MEMORY.md` + consolidate the 17 fact files into ~5 current-state files (built-state summary, open items, positioning/roadmap decisions, prompt-eng reference, bugs-if-any-still-open).
- Global `~/.claude/CLAUDE.md`: back up alongside as `CLAUDE.md.bak-20260815` → rewrite work-context section (Project Liberty/HCP framing is stale per its own note); owner reviews the diff before I consider it done.
- Local branches: `git branch -d` (safe delete only — refuses unmerged) for task branches whose PRs are merged; keep `backup-pre-scrub-20260731` and anything `-d` refuses.

**Phase 4 — verification (maps to ACs)**
- Size report: before/after KB + est. tokens for every touched file (AC2 ≥60% on lessons/next-steps).
- Dead-decision grep: keyword list built during Phase 1 (e.g. frames-view, llmProposalSchema, v3 auth surface, Azure Entra) → no hits outside `decisions/` + `spec-changelog.md` (AC6).
- `ls docs/tasks/active/` → only this task (AC1); ADR status audit (AC3); memory contradiction check (AC4); `pnpm test` at root (AC7).

**Test plan note (TDD):** docs-only task — no unit tests; the AC list above is the verification suite, executed and journaled at Gate 5. Spec-sync: not touched (no `packages/protocol` change).

**Cross-package impact:** none at runtime. Consumers of the docs (slash commands `/pickup`, `/close-session`, PROMPT_TEMPLATES.md) reference `done/` as files — Phase 0 amendments update those references.

## Decisions & surprises

- 2026-08-15 — Owner approved compaction over accumulation (interview) → ADR-0027 drafted as `proposed`; flips `tasks/README.md` "kept forever".
- 2026-08-15 — Session memory claiming the app-reply fix is "unpushed on 975f713" conflicts with merged PR #40 on main — memory staleness confirmed as a live problem, not hypothetical.

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: inventory of docs footprint (sizes, counts, structure); task file created.
- State: draft — awaiting interview answers, then plan.
- Next step: interview → write plan → branch → stop for approval.
- Open questions: see Decisions & surprises.
