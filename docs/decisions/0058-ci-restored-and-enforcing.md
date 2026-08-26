# 0058 — CI returns as the merge gate, and this time it enforces

- **Status:** **accepted** (2026-08-26, owner-directed at each decision point). Supersedes
  the operative half of **ADR-0041** (the merge gate moves from GitHub Actions to one local
  command); ADR-0041's *reasoning* is preserved and still governs `gate:local`, which
  remains the pre-push gate and a proven superset.
- **Date:** 2026-08-26
- **Task:** TASK-20260826-ci-restore (written retroactively — see its header)

## Context

ADR-0041 removed `ci.yml`'s `on:` triggers on 2026-08-20 for two stated reasons:

1. **Actions was billing-blocked.** Every run died in ~2 s with zero steps executed.
2. **CI never actually blocked a merge anyway.** A private repo on a free org plan cannot
   have branch protection or required status checks (`403 Upgrade to GitHub Pro`), so the
   red X was pure noise — and noise that *trains the sole reader to merge past reds*.

Both premises died with the flip to public (TASK-20260825-flip-public-execute, 2026-08-26):

- **Billing dissolved rather than being fixed.** Public repos get unlimited standard-runner
  minutes. Confirmed empirically before changing anything — a dispatch run on `main`
  executed its steps instead of dying instantly (run `32931999710`).
- **Required status checks became available**, so a red CI can now actually block.

A third fact made restoration urgent rather than merely possible: **an outside
contributor's PR cannot be gated by `gate:local`**, a command that only runs on the
maintainer's Mac. Public repos receive outside PRs.

## Decision

**Restore `push` (on `main`) and `pull_request` triggers, and make `workspace` and
`desktop-shell (macos-latest)` required status checks on `snug`'s `main-pr-only` ruleset.**

Three constraints came with it:

1. **Park the Windows leg** rather than leave it red. ADR-0021 D8 wants that leg red as
   live evidence of R-5 — but *at the `keyReachable` assertion*. Since TASK-20260820
   deleted `icons/icon.ico` for the macOS-only bundle it dies at **compile** instead, so a
   genuine R-5 regression and a missing icon are the same colour. It had been vouching for
   nothing while costing a permanent X on every PR — precisely the ADR-0041 failure mode,
   reintroduced by accident. Restore preconditions are written into the matrix comment and
   match ADR-0021 D8's existing post-1.0 list. **Do not soften `keyReachable` to make it
   green.**
2. **Fix, never waive, what the first live run exposed.** Two CPU-bound-by-design suites
   crossed vitest's 5000 ms default on 4-core shared runners (12–16× slower than local).
   Sized from measurement, not guesswork, in PR #141.
3. **`spec` gets no required check.** It has the same ruleset but **no workflows at all**;
   a required check there would deadlock the repo permanently, SPEC_SYNC pushes included.

## Consequences

- **A red CI now blocks a merge.** Proven, not assumed: a probe PR was refused with *"the
  base branch policy prohibits the merge"*, then closed and its branch deleted.
- **Contexts are pinned to `integration_id: 15368`** (github-actions) so another app cannot
  satisfy a same-named check. The names were read from the live check-runs API rather than
  reconstructed from the workflow, because `desktop-shell (macos-latest)` is *generated*
  from the matrix and a mismatched context blocks every merge with no diagnostic.
- **`gate:local` keeps its job and its contract.** It remains the pre-push gate and a
  deliberate superset (it runs Playwright and the server smoke leg, which CI does not).
  AC3 still fails if a CI step loses its local counterpart — verified 14/14 after the
  matrix change, since that test keys on job *ids*, not on the OS matrix.
- **`strict_required_status_checks_policy` is `false`**, so a PR may merge without
  rebasing onto a newer `main`. With a solo maintainer that is the right trade; revisit if
  a second committer appears.
- **The Windows leg's absence is now the only unverified platform claim.** ADR-0021 D8
  already accepted that (macOS-only through 1.0); this ADR narrows it from "red for a
  reason we assert" to "not run, with the restore preconditions written down".
- **Fixing the timeouts also closed the long-standing `@snugprotocol/db` load flake**,
  which was never mysterious — the same 5000 ms default against 600 000 PBKDF2 iterations.

## Alternatives rejected

- **Restore triggers first, fix failures after.** Would have put a red X on every PR of a
  freshly-public repo — the exact behaviour ADR-0041 removed the triggers to prevent.
- **Leave the Windows leg red and mark it `continue-on-error`.** Keeps a signal that cannot
  distinguish a compile break from an R-5 regression, and `continue-on-error` makes it
  *quieter*, which is worse: a leg nobody looks at asserting something nobody checks.
- **Give `spec` the same required checks for symmetry.** Would permanently deadlock a repo
  that has no CI to satisfy them.
- **Fix billing and keep the old arrangement.** Nothing to fix; the constraint dissolved.
