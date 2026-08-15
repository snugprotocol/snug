# TASK-20260815-docs-context-cleanup: Prune stale/conflicting docs and memory to cut per-session context cost

- **Status**: in-review (all phases executed; PR open)
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

- 2026-08-15 — Owner approved compaction over accumulation (interview) → ADR-0027 accepted; flips `tasks/README.md` "kept forever".
- 2026-08-15 — Session memory claiming the app-reply fix is "unpushed on 975f713" conflicted with merged PR #40 on main — verified: 975f713 is a dangling commit; #40 is a strict superset. Memory staleness confirmed live, corrected in the consolidated memory.
- 2026-08-15 — "OAuth popup still unbuilt" memory refuted: the popup flow was reinstated in P3 (`baa4588`), inside the very merge the memory describes.
- 2026-08-15 — All 11 audited active tasks were merged/closed-by-harvest; the only genuinely open work was extracted to next-steps (20-item rollup, deduped).
- 2026-08-15 — Lessons audit dropped NOTHING outright: all 60 rules still guard live surfaces (5 merged as duplicates). The bloat was narrative, not dead rules.
- 2026-08-15 — `internal/` is gitignored, so its banners are disk-only (C4 enforced by gitignore; nothing to commit).
- 2026-08-15 — Local branch `feat/TASK-20260807-starters-auth-spectrum` deleted by `-d` because it matched its upstream; the AL-09 harvest commit `86a564c` survives on `origin/…` (remote untouched).
- **FLAGS for owner (from the ADR audit, recorded here — decisions, not drift):**
  1. ADR-0021 D8's Electron-fallback trigger is MET (Windows gate red since 2026-08-13) but the a/b/c platform choice has no ADR yet — whichever is chosen needs its own ADR or a 0021 amendment.
  2. `llmProposalSchema` still exists in `packages/auth/src` though ADR-0017 named its deletion a P4 exit item; v3's `snug_auth_specs` WAS dropped, so this looks like a retained/repurposed inferrer schema — confirm the P4 exit item is genuinely closed.

## Verification record (Gate 5, 2026-08-15)

- **AC1** ✅ `docs/tasks/active/` holds only this task (11 files closed to `done/INDEX.md`, each verified against `git log main` first).
- **AC2** ✅ lessons.md 76,117 → 16,804 bytes (−78%); next-steps.md 102,240 → 15,889 bytes (−84%); both hold only re-verified content.
- **AC3** ✅ 28 ADRs audited; 9 status lines now carry their amendments (0001/0003/0004/0005/0007/0016/0017/0020/0023); none deleted; README vocabulary updated.
- **AC4** ✅ auto-memory 18 → 4 files (current-state / open-threads / owner-decisions / prompt-reference); every claim re-verified; two refuted claims corrected; backup at `memory/backup-20260815/`.
- **AC5** ✅ code-map (6 findings) + architecture (7 findings + the stale "broker remains v1.1" line) fixed against the real tree; ~120 path pointers verified.
- **AC6** ✅ dead-symbol grep (`ConnectionsCard`, `resolveWizardIntent`, `putAuthSpec`, `llmProposalSchema`, `snug_auth_specs`, `auth-wizard.spec`): every hit outside `decisions/`+`spec-changelog` explicitly states the symbol is deleted/dropped.
- **AC7** ✅ `turbo run test --force` from root: 21/21 tasks, **Cached: 0**, all green (playground 1028/1028).
- Also: 15 merged local branches pruned (`-d` only; `backup-pre-scrub-20260731` kept); global `~/.claude/CLAUDE.md` work-context corrected (backup `.bak-20260815`); `internal/` bannered on disk.

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: inventory of docs footprint (sizes, counts, structure); task file created.
- State: draft — awaiting interview answers, then plan.
- Next step: interview → write plan → branch → stop for approval.
- Open questions: see Decisions & surprises.

### 2026-08-15 (later) — Claude (Fable 5) — session
- Done: owner approved the plan → executed all phases. 10 parallel read-only audits against `git log main` + live code (done-index ×3, active tasks, lessons, next-steps, ADRs, code-map/architecture, internal/, auto-memory). Writes: ADR-0027 accepted + process docs amended (fed1482); done/ → INDEX.md, 53 files deleted (then +11 more closed); lessons distilled −78% (d287ed6); ADR status lines (64e4147); code-map/architecture drift (6d53637); next-steps rewritten −84% + 11 active tasks closed (4f52170). Non-git: memory 18→4, global CLAUDE.md corrected, internal/ bannered, 15 branches pruned — all backed up first.
- State: in-review — verification record above all green; PR open.
- Next step: owner reviews the PR (diff + this file), merges; then this file's own line goes to done/INDEX per the new Gate-6 rule. Owner FLAGs 1–2 (Decisions section) remain open.
- Open questions: none for this task.
