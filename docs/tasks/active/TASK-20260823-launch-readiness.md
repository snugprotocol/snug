# TASK-20260823-launch-readiness: Pre-launch hardening audit, repo cleanup, and flip-to-public checklist

- **Status**: draft
- **Owner**: Jeetu
- **Risk tier**: high (touches CI/release config surface, repo-visibility procedure, org-wide GitHub settings; visibility flip itself stays an explicit owner ask per PROCESS.md release rules)
- **Branch**: `chore/TASK-20260823-launch-readiness`
- **Packages touched**: docs, repo/GitHub settings, git branch hygiene (no product code expected; anything found becomes a child task or a scoped fix here)
- **Spec impact**: none
- **Related**: ADR-0013 (static zero-backend), ADR-0027 (git history is the archive), ADR-0052 (feedback deep-links go live at flip), TASK-20260821-launch-security-review (merged), `docs/next-steps.md` (queue of record), memory `snug-open-threads`

## Spec (what & why)

The owner will flip `snugprotocol/snug` (and, on its own explicit ask, `snugprotocol/spec`) from private to public and announce on HN Show. Before that flip, this task (a) produces the single authoritative **launch-readiness checklist** — every open pre-launch item from next-steps/open-threads triaged into blocker / flip-day / post-launch, (b) **hardens the repo for public eyes** — full-history secret scan, PR/issue content scan, GitHub repo/org settings review, dependency audit, (c) **cleans up git branches** — delete squash-merged leftovers, preserve the deliberately-parked ones, and (d) records the **history-retention decision** for the flip. The flip itself and the HN post are OUT of this task — they happen only on the owner's explicit ask in a later session.

**Acceptance criteria** (verification, not unit tests — this is an ops/docs task):
1. A launch-readiness checklist exists in the task file (and distilled into `docs/next-steps.md`), with every item sourced from next-steps/open-threads/memory and triaged blocker vs flip-day vs post-launch; owner has reviewed it.
2. Full-history secret scan (gitleaks or equivalent) over all refs runs clean, or every finding is remediated/accepted in writing.
3. PR bodies/comments + issue content scanned for sensitive strings (emails, tokens, local paths); findings triaged.
4. Branch cleanup executed: every branch whose PR squash-merged is deleted locally and on origin; `backup-pre-scrub-20260731` (local-only), `origin/feat/TASK-20260820-instagram-starter` (parked until post-1.0), `origin/feat/TASK-20260807-starters-auth-spectrum` (AL-09 harvest source) are preserved; the unmerged-branch inventory with rationale is recorded here.
5. History-retention decision recorded (ADR or decision note): what happens to history/branches/PRs at flip, including the fact that PRs+issues become public with the repo.
6. GitHub settings pass: branch protection on main, Actions permissions, org member visibility, repo metadata (description, topics, website URL), `.github` org landing flip-day edit identified and staged.
7. Flip-day runbook written: ordered steps for the day the owner flips (verify feedback prefill live, sync-website check, spec-repo flip sequencing, HN post timing), each with its verification.

**Out of scope**: the visibility flip itself; the HN post; npm publishes; deploying playground/website; merging the instagram branch; fixing CI billing (owner-side billing action — tracked as a checklist blocker, not performed here).

## Decisions & surprises

- 2026-08-23 — **Owner interview (Gate 1)**: (1) **Retain full git history** at flip, gated on clean full-history secret scan + PR-content scan (squash-fresh rejected; ADR-0027 archive + transparent build trail are assets). (2) **Delete squash-merged branches now**, SHAs ledgered below. (3) **Delete `origin/feat/TASK-20260810-dynamic-auth-rewrite`** (planning-only branch; shipped rewrite + ADRs are the record). (4) **CI billing is NOT a launch blocker** — owner will flip on local evidence (gate:local doctrine); public red X's on recent PRs accepted, workflows re-run post-launch when billing is fixed.

### Pre-deletion SHA ledger (2026-08-23, recovery anchors)

Deleted local: aa3a660 chore/TASK-20260817-telepath-done · 9edd78a chore/TASK-20260818-registered-flag-close · 6e7acfb chore/TASK-20260818-shutdown-done · 303d3a0 docs/TASK-20260821-launch-security-review-close · 5ea130d feat/TASK-20260815-inline-cards · 0393a1f feat/TASK-20260815-provider-chat-lane · 8793384 feat/TASK-20260815-starter-apps-rebuild · c67abf3 feat/TASK-20260817-telepath · eaf5ad7 feat/TASK-20260820-desktop-bundle-targets-macos · dc15e1f feat/TASK-20260820-desktop-bundle-targets-macos-close · 189b2c3 feat/TASK-20260821-launch-security-review · d8379d0 feat/TASK-20260822-gmail-dual-mode · 9e519ed fix/TASK-20260818-registered-flag · a3d5a4e fix/TASK-20260818-sidecar-shutdown

Deleted origin: 15444e1 chore/TASK-20260814-hue-starter-done-move · aa3a660 chore/TASK-20260817-telepath-done · 9edd78a chore/TASK-20260818-registered-flag-close · 6e7acfb chore/TASK-20260818-shutdown-done · f28b109 docs/TASK-20260810-plan · b7cd8e2 feat/TASK-20260806-flip-prep · b03ffd1 feat/TASK-20260806-spec-push · 5a8819a feat/TASK-20260806-starters-auth-spectrum · 739e3b4 feat/TASK-20260806-starters-pillars · ac0ed6a feat/TASK-20260806-webllm-spike · 2195b66 feat/TASK-20260810-dynamic-auth-rewrite · f54dfcc feat/TASK-20260810-p5-security-close · 985c7a3 feat/TASK-20260814-hue-starter-real-connection · 5ea130d feat/TASK-20260815-inline-cards · 0393a1f feat/TASK-20260815-provider-chat-lane · 8793384 feat/TASK-20260815-starter-apps-rebuild · c67abf3 feat/TASK-20260817-telepath · 03db79d feat/TASK-20260818-ledger-starter · eaf5ad7 feat/TASK-20260820-desktop-bundle-targets-macos · dc15e1f feat/TASK-20260820-desktop-bundle-targets-macos-close · 189b2c3 feat/TASK-20260821-launch-security-review · d8379d0 feat/TASK-20260822-gmail-dual-mode · 404d54a fix/TASK-20260814-hue-pairing-e2e · 9e519ed fix/TASK-20260818-registered-flag · a3d5a4e fix/TASK-20260818-sidecar-shutdown

Kept: 698028a backup-pre-scrub-20260731 (local-only, never push) · 1d255b4 feat/TASK-20260820-instagram-starter (local + origin, parked until post-1.0) · 86a564c origin/feat/TASK-20260807-starters-auth-spectrum (AL-09 harvest source)

- 2026-08-23 — Branch survey: all 120 PRs merged, 0 open. Local `git fetch --prune` already removed refs GitHub auto-deleted. Remaining branches cross-checked against merged-PR head names (`gh pr list --state merged`) — ancestry checks are useless here because merges are squash.
- 2026-08-23 — `backup-pre-scrub-20260731` is DISJOINT from main (no merge-base): main was fresh-bootstrapped 2026-07-31; the backup holds the 2-commit pre-scrub original. It exists only locally — it is not exposed by a flip.
- 2026-08-23 — `spec` repo is PRIVATE too; `.github` is already public. Flip is a two-repo sequence plus an org-landing edit.

### Branch inventory (evidence, 2026-08-23)

**Delete (squash-merged via PR, verified by head-name match)** — local: chore/TASK-20260817-telepath-done, chore/TASK-20260818-registered-flag-close, chore/TASK-20260818-shutdown-done, docs/TASK-20260821-launch-security-review-close, feat/TASK-20260815-inline-cards, feat/TASK-20260815-provider-chat-lane, feat/TASK-20260815-starter-apps-rebuild, feat/TASK-20260817-telepath, feat/TASK-20260820-desktop-bundle-targets-macos, feat/TASK-20260820-desktop-bundle-targets-macos-close, feat/TASK-20260821-launch-security-review, feat/TASK-20260822-gmail-dual-mode, fix/TASK-20260818-registered-flag, fix/TASK-20260818-sidecar-shutdown; origin: chore/TASK-20260814-hue-starter-done-move, chore/TASK-20260817-telepath-done, chore/TASK-20260818-registered-flag-close, chore/TASK-20260818-shutdown-done, docs/TASK-20260810-plan, feat/TASK-20260806-flip-prep, feat/TASK-20260806-spec-push, feat/TASK-20260806-starters-pillars, feat/TASK-20260806-webllm-spike, feat/TASK-20260810-p5-security-close, feat/TASK-20260814-hue-starter-real-connection, feat/TASK-20260815-inline-cards, feat/TASK-20260815-provider-chat-lane, feat/TASK-20260815-starter-apps-rebuild, feat/TASK-20260817-telepath, feat/TASK-20260818-ledger-starter, feat/TASK-20260820-desktop-bundle-targets-macos, feat/TASK-20260820-desktop-bundle-targets-macos-close, feat/TASK-20260821-launch-security-review, feat/TASK-20260822-gmail-dual-mode, fix/TASK-20260814-hue-pairing-e2e, fix/TASK-20260818-registered-flag, fix/TASK-20260818-sidecar-shutdown; plus origin/feat/TASK-20260806-starters-auth-spectrum (ancestry-merged, no PR).

**Keep (never delete without owner):**
- `backup-pre-scrub-20260731` (local only) — pre-scrub archive; never push.
- `origin/feat/TASK-20260820-instagram-starter` (+ local twin, same tip 1d255b4) — complete, deliberately unmerged until post-1.0 release decision (owner directive at pickup).
- `origin/feat/TASK-20260807-starters-auth-spectrum` (tip 86a564c) — AL-09 parked as harvest source (2026-08-10 redirect).

**Owner decision needed:**
- `origin/feat/TASK-20260810-dynamic-auth-rewrite` (tip 2195b66) — Gate-1/2 planning commits only; the rewrite shipped via other branches. Unmerged, so deleting loses that planning history permanently.

## Plan

Ops/docs task — no product code; anything discovered that needs code becomes a scoped fix here (Low) or a child task (Medium+). Order:

1. **Branch cleanup** — DONE 2026-08-23 pre-approval on the owner's explicit interview answer (ledger above). Final state: `main`, this task branch, 3 kept branches only.
2. **Full-history secret scan (AC2)** — run gitleaks (`brew install gitleaks` if absent; fallback trufflehog) with `--log-opts="--all"` over every ref incl. the kept parked branches and `backup-pre-scrub-20260731` (local-only, but scan anyway — belt and braces). Triage: real secret → remediate + rotate + owner decision on history; false positive → `.gitleaks.toml` allowlist committed on this branch.
3. **PR/issue/discussion content scan (AC3)** — `gh pr list/view --json body,comments,reviews` over all 120 PRs + issues; grep for token shapes, emails (other than the public security@ address), `/Users/jeetu` paths, provider client IDs/secrets. Findings triaged; GitHub PR comments are editable if something must be scrubbed.
4. **GitHub settings pass (AC6)** — `gh api` audit of: main branch protection, Actions workflow permissions (default token read-only), fork/PR settings, repo description/topics/homepage (point at snugprotocol.org), org people-visibility, dependabot/secret-scanning toggles GitHub enables for public repos. Stage (not apply) the `.github` org-landing flip-day edit text.
5. **Launch checklist assembly (AC1)** — full read of `docs/next-steps.md` + open-threads memory; every open item triaged **blocker / flip-day / post-launch** in this task file; distilled copy into next-steps. CI billing pre-classified post-launch per owner answer (public red X's accepted; workflows re-run when billing fixed).
6. **Flip-day runbook (AC7)** — `docs/runbooks/flip-to-public.md`: ordered, each step with verification — snug repo flip → verify ADR-0052 feedback prefill live → `.github` landing edit → spec repo flip (its own explicit ask, per standing rule) → website/playground deploy checks (`/sync-website` gate green) → teaser cut check → HN post window. Includes explicit DO-NOTs (never push `backup-pre-scrub`, never merge instagram branch).
7. **History-retention decision note (AC5)** — short ADR: retain full history + PRs at flip, scan-gated; records that PRs/issues/review comments go public with the repo and that the pre-scrub archive stays local-only.
8. **Gate 6** — journal, lessons if any, distill next-steps, commit all on this branch, PR.

**Test plan**: ops verification per AC (scan outputs, `gh api` evidence, final `git branch -a` state) recorded in the journal; no unit tests. Root `pnpm test` run once before PR to confirm the branch touches nothing green.

**Cross-package impact**: none (docs + GitHub settings only).
**Spec-sync**: n/a.

## Session journal (append-only, newest last)

### 2026-08-23 — Claude (Gate 1) — session
- Done: branch survey (all refs vs merged-PR heads), repo-visibility check (snug PRIVATE, spec PRIVATE, .github PUBLIC), scrub-history archaeology (main disjoint-bootstrapped 2026-07-31), task file created.
- State: awaiting owner interview answers (history retention, branch-cleanup timing, scope shape, CI-billing assumption).
- Next step: fold answers, write plan, create branch, stop for plan approval.
