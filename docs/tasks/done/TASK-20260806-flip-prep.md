# TASK-20260806-flip-prep: Flip-public prep — community files, real good-first-issues, staged runbook (AL-14, A11)

- **Status**: done — merged to main via PR #19 (2026-08-06)
- **Owner**: Jeetu (autonomous run; Claude implements — umbrella TASK-20260805-alpha-umbrella, child AL-14; plan pre-approved by Phase-0 decision 6)
- **Risk tier**: low (docs + `.github/` metadata; no package code). Gates still apply.
- **Branch**: `feat/TASK-20260806-flip-prep`
- **Packages touched**: none (root community files, `.github/`, `docs/`; `internal/` untracked)
- **Spec impact**: none
- **Related**: umbrella AL-14 row + Phase-0 decision 5 (**prep-only depth**: files + REAL good-first-issues on the private repo; internal/-strip, branch protection, item-0 purge stay STAGED as a runbook, not executed) · `internal/LAUNCH_OPS.md` · roadmap A11 · next-steps 2026-08-06 breadcrumb-sweep entry (queued from the AL-01 review) · staged drafts produced by a prior drafting agent (drafted against pre-AL-02 main — verify before placing)

## Spec (what & why)

Make the repo *community-ready on paper* before the flip-public ask ever comes: real SECURITY/CONTRIBUTING/CoC, CODEOWNERS and issue/PR forms under `.github/`, a curated and **currently-true** list of ten good first issues opened as real labeled issues on the private `snugprotocol/snug`, the flip-public checklist reduced to an executable staged runbook (kept in untracked `internal/` per C4), and the queued machine-path/breadcrumb sweep of `docs/tasks/**` done and made a permanent runbook step. A prior drafting agent staged the content set against an older `main` (pre auth-core/starters/spec-push, 4 merges ago); this task's job is **verify, correct, place, and finish** — not redraft.

**Acceptance criteria** (docs task — verification is review + grep + green suites, tests where practical):
1. Community file set placed at final repo paths with zero stale claims: SECURITY.md (no broker overclaim; auth-core reality), CONTRIBUTING.md (current commands/versions; spec-repo state = **content pushed at v0.1+v0.2-draft, repo still private**), CODE_OF_CONDUCT.md (full Covenant 2.1 + enforcement ladder), `.github/CODEOWNERS` (root `CODEOWNERS` deleted in the same change), `.yml` issue forms replacing the old `.md` templates + `config.yml` + security stop-template, richer PR template, `docs/good-first-issues.md`.
2. Every one of the 10 good-first-issue entries is verified against **current** `main` (file+symbol exists, problem still real, not owned by a pending umbrella child). The three the drafter flagged as being fixed by AL-01 (`supportsCaching`, `importUserDb`/`namespaceByFile`, code-map script) are confirmed fixed and replaced.
3. The 10 issues exist for real on `snugprotocol/snug`, each labeled `good first issue`; labels the templates reference (`bug`, `enhancement`, `good first issue`) exist; issue numbers recorded in this file.
4. `docs/tasks/**` (incl. `done/`) carries no machine paths (`/Users/…`, `/tmp/…`), no live-key-location breadcrumbs, no personal-identifying residue (public info — owner byline, public GitHub handle — and source-system codenames stay). Findings + scrubs recorded here; the sweep added to the runbook as a permanent pre-flip step.
5. `internal/RUNBOOK-flip-public.md` staged in the worktree's untracked `internal/` (C4 — internal/ is gitignored; **the tracked deliverable is everything else**; the owner copies the runbook to the canonical repo's `internal/`); its `gh` commands (branch-protection JSON, item-0 purge, visibility flip, PVR enable) verified against current `gh`/REST syntax; stale drafting-era claims fixed (PR count, spec-repo state, GFI overlap note).
6. README gets **only flip-critical corrections** per the drafter's README-gaps note: stale `packages/auth` row, wrong BYOK-storage claim (keys live in `snug_secrets`, NOT sessionStorage), hardcoded starter count, clone placeholder, contributor on-ramp line, one security-posture sentence, MIT badge, pre-launch banner → honest pre-1.0 line. No rewrite (B8 owns that).
7. Root `pnpm build` + `pnpm test` green at close (docs-only change — prove no breakage).

**Out of scope**: executing internal/-strip, branch protection, item-0 purge, repo settings, CI workflow, or any visibility change (all staged 🔒/⏳ in the runbook per Phase-0 decision 5) · README rewrite/GIF/FAQ (B8) · quickstart timing re-measurement (umbrella AC3) · the `/settings` BYOK DOM echo (AL-10 owns) · npm/deploy/flip (never in this run).

## Plan

Order (each step = one task-id-prefixed commit):
1. This task file (Gates 1+2).
2. **Place + correct community files**: replace root `SECURITY.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md`; add `.github/CODEOWNERS`, delete root `CODEOWNERS`; replace `.github/PULL_REQUEST_TEMPLATE.md`; swap `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md` for `.yml` forms + `config.yml` + `security.md` stop-template. Corrections over drafts: SECURITY scope's auth paragraph → present tense (auth core landed at AL-02; injection runtime is AL-03), bug-form area list unchanged (verified current), CONTRIBUTING spec-repo sentence already correct (downstream, never PR'd) — verify only.
3. **`docs/good-first-issues.md`** rewritten to the verified 10 (drops 3 fixed by AL-01; adds 3 verified from the next-steps queue: raw-markdown chat rendering, signed-out sync 401 copy, StrictMode `?idea=` handoff), then **open the 10 issues** (`gh label create --force` ×3, `gh issue create` ×10 — the only remote actions this task may take, only on `snugprotocol/snug`), record numbers here.
4. **Breadcrumb sweep** scrubs (found by `grep -rn "/Users/|/tmp/|.env.local|@gmail"` over `docs/tasks/`): umbrella Phase-0 repo-root path, umbrella key-location note, hub-polish `/tmp/…` backup path. Record here.
5. **README** minimal patches (AC6 list).
6. Runbook placed in untracked `internal/` (worktree only) with syntax fixes; code-map row for the community surface; next-steps ✅ entry; journal; final root build+test run.

Cross-package impact: none (no source files). Test plan: no new scripts introduced → no new tests (Low tier, tests-where-practical: the `.yml` issue forms are lint-checked by GitHub at render time; local check = YAML parse via node during review). Suites prove non-breakage at close.

## Decisions & surprises

- Drafter's open question (runbook stage 3: open 7 vs 10 issues, overlap with A9/A15) — **resolved by construction**: the overlapping entries (supportsCaching → A9-adjacent, code-map script → A15) were already merged by AL-01, so they're dropped and replaced; all 10 remaining entries are unowned by any pending child. Open all 10.
- README's BYOK claim ("kept in sessionStorage") was not on the drafter's gaps list but is factually wrong since the portable-hub era — keys live in the user DB's `snug_secrets` (deliberate documented trade, `apps/playground/src/state/mode.ts`). Corrected as flip-critical (it's a security claim).
- `internal/` in this worktree contains only the two files the umbrella staged for AL-14 (`07-roadmap.md`, `LAUNCH_OPS.md`) — internal/ is gitignored so worktrees don't carry it. The runbook lands beside them for the owner to copy to the canonical repo's `internal/`; noted in the runbook header.
- Good-first-issue #6 (examples validator) rewritten, not just re-verified: the drafter's version predated AL-08 (3 hardcoded apps, `index.html`); current reality is 8 apps in `APPS`, per-app file is `app.html`, and discovery must preserve the explicit `LLM_FREE_APPS` posture declaration (ADR-0011).

### Issue numbers (AC3) — opened 2026-08-06 on snugprotocol/snug

Recorded after `gh issue create`:

| # | GFI | Issue |
|---|---|---|
| 1 | Stop rendering "0% cached" as if it were information | [#9](https://github.com/snugprotocol/snug/issues/9) |
| 2 | Sync divergence buttons should state their consequence | [#10](https://github.com/snugprotocol/snug/issues/10) |
| 3 | Signed-out "this hub" sync should say "sign in first", not "(401)" | [#11](https://github.com/snugprotocol/snug/issues/11) |
| 4 | Builder chat renders raw markdown | [#12](https://github.com/snugprotocol/snug/issues/12) |
| 5 | StrictMode double-mount kills the hub → builder `?idea=` handoff on dev | [#13](https://github.com/snugprotocol/snug/issues/13) |
| 6 | Example validator should discover apps, not hardcode them | [#14](https://github.com/snugprotocol/snug/issues/14) |
| 7 | Surface *why* an inspector entry's payloads are missing | [#15](https://github.com/snugprotocol/snug/issues/15) |
| 8 | Script: `check-spec-sync` guard | [#16](https://github.com/snugprotocol/snug/issues/16) |
| 9 | Script: dead-link check for `docs/` | [#17](https://github.com/snugprotocol/snug/issues/17) |
| 10 | Glossary entries for the observability era | [#18](https://github.com/snugprotocol/snug/issues/18) |

Labels ensured via `gh label create --force`: `good first issue` (7057ff), `bug` (d73a4a), `enhancement` (a2eeef) — the two template labels + the curated one. Issue bodies = the corresponding `docs/good-first-issues.md` entries.

### Breadcrumb sweep results (AC4)

Swept `docs/tasks/**` (active + done, 30 files) for `/Users/…`, `/home/…`, `/tmp/…`, `C:\`, key-location breadcrumbs, personal emails, family identifiers. Scrubbed:
1. `active/TASK-20260805-alpha-umbrella.md` Phase-0 preflight — absolute repo-root path removed (machine path).
2. `active/TASK-20260805-alpha-umbrella.md` Phase-0 decision 4 — "leaving an Anthropic or OpenAI key in `internal/.env.local`" → live key supplied locally, location unstated (key-location breadcrumb).
3. `done/TASK-20260804-hub-polish.md` D3 note — a dated `/tmp/…` backup path → "a local backup outside the repo" (machine path to a user-data backup; the literal path is deliberately not repeated here).

Kept deliberately: source-system codenames (approved indirection, stay per instructions) · `internal/.env.local` as the *codename/branch* indirection pointer (named in the root AI files themselves — consistent posture until the runbook's stage-1 public rewrite) · `apps/server/.env.local` env-var documentation (app config, not personal) · public handles/byline (`jeetumaker`, Jeetu Maker) · `scratchpad` as a word (no path). Sweep added as runbook stage 1 step 6 (permanent).

## Session journal (append-only, newest last)

### 2026-08-06 02:30 — Claude (Fable 5) — session (AL-14 child, isolated worktree)
- Done: Gate-1/2 reads (umbrella AL-14 row + Phase-0 decision 5, LAUNCH_OPS, roadmap A11, PROCESS, next-steps queued entries, current README/SECURITY/CONTRIBUTING/CoC/templates, all staged drafts); verified every draft claim and all 13 GFI candidates against current main (greps + file reads recorded above); this spec/plan.
- State: plan approved by umbrella pre-approval; executing.
- Next step: place corrected community files.

### 2026-08-06 03:05 — Claude (Fable 5) — session close (Gate 6)
- Done: community set placed + corrected (commit 17f0bca); good-first-issues rewritten to a verified 10 (e034a3d); labels ensured + **issues #9–#18 opened for real** on `snugprotocol/snug` (~09:55 UTC, `gh label create --force` ×3 + `gh issue create` ×10 — the only remote actions taken, per authorization); breadcrumb sweep executed + scrubs committed (ec6a094); README flip-critical patches (5d4733c); runbook finalized into this worktree's untracked `internal/RUNBOOK-flip-public.md` (stages 2–3 marked ✅ DONE, PR/issue numbers current, branch-protection JSON moved to the non-deprecated `checks:[{context}]` form, `gh repo delete --yes` + `delete_repo` scope noted, purge recommendation flipped to Support-ticket now that issues exist, breadcrumb sweep added as permanent stage-1.6, LAUNCH_OPS diff folded in: trademark check + org 2FA/second-owner + footer-link check added to gates); code-map community row + INDEX row + next-steps ✅ entries; root `pnpm build` + `pnpm test` green (counts in the close commit message).
- **AC5 note (runbook custody):** `internal/` is gitignored, so the runbook exists ONLY in the AL-14 worktree's `internal/` — the owner must copy it to the canonical repo's `internal/` (called out in the runbook header). The tracked deliverable is everything else on this branch.
- State: all ACs met; branch ready for PR + AI review (Gate 5 by parent).
- Next step (parent): PR, review, merge; owner copies the runbook file; morning report lists issues #9–#18.
- Open questions: none blocking. Residue parked in the runbook footer (purge option, codenames-in-done-tasks, npm org status).

### 2026-08-06 — Claude (Fable 5) — review round (adversarial review verdict: MERGE-AFTER-FIXES)
- Review verified the deliverable inventory as true (files placed as claimed, issues #9–#18 live and labeled, sweep scrubs real, suites green at 1054) and returned 3 blockers + 4 minors, all applied on this branch:
  - **Blockers (custody-claim drift — ADR-0014 clause 5 forbids the absolute "secrets never sync"):** SECURITY.md C1 bullet now says secrets are stripped from **hub-bound** sync pushes and adds the personal-origin caveat ("A personal sync origin you explicitly connect (e.g. your own Dropbox) carries the full file, secrets included — that is how credentials travel between your own devices (ADR-0014)"); the C1 in-scope bullet mirrors it ("a hub-bound sync push"); a matching out-of-scope line added ("Secrets present in a personal sync origin you connected — that is by design (ADR-0014)"); README BYOK line now "stripped from hub sync and default exports" (no absolute — the caveat lives in SECURITY.md).
  - **Minors:** Discussions enabled for real (`gh api -X PATCH repos/snugprotocol/snug -F has_discussions=true` → `true`, coordinator-authorized; kills the config.yml 404; runbook stage-6 step marked ✅) · CODEOWNERS workflows line annotated "(future — CI lands with the hardening task)" · doctrines-devex journal line no longer names the key file ("a key-location note" — the surviving breadcrumb this task's own sweep pattern matches).
  - **Carried to the owner (morning report):** `internal/07-roadmap.md` §2 states the absolute claim ("'your keys never leave your file' is true and stays true"), superseded by ADR-0014 clause 5 (personal sync origins carry secrets by design). Not editable from this worktree (that file lives only in the canonical repo's untracked `internal/`) — owner should amend §2's claim-discipline line to "your keys never reach anyone else's server" or equivalent.
- Verification: `pnpm build` green after fixes.
- State: review fixes committed; branch final. Next: parent merges.
