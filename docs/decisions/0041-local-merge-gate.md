# 0041 — The merge gate moves from GitHub Actions to one local command

- **Status:** **accepted** (2026-08-20, owner decision at Gate 2; shipped with
  TASK-20260820-local-ci-gate). Supersedes nothing; amends the operating assumption behind
  `.github/workflows/ci.yml` (authored TASK-20260812-desktop-hub-scaffold P5).
- **Date:** 2026-08-20
- **Task:** TASK-20260820-local-ci-gate

## Context

GitHub Actions has been billing-blocked since ~2026-08-18. Every run since failed in ~2 s
with zero steps executed and the annotation *"The job was not started because recent account
payments have failed or your spending limit needs to be increased"* — workspace and both
desktop-shell legs alike, on `main` and on every PR. Roughly a dozen tasks merged on local
evidence alone, and `docs/next-steps.md` carried it as a red owner-action item.

Two facts discovered while acting on it change the picture:

1. **CI never actually blocked a merge.** This repo is private on a free org plan, so branch
   protection and required status checks were never available — the API answers
   `403 Upgrade to GitHub Pro` for both `/branches/main/protection` and `/rulesets`. The red
   X was advisory, with no enforcement behind it.
2. **A blocked run is worse than no run.** It renders as an ordinary red X, indistinguishable
   from a real break without opening the check annotation. It trains the one person reading
   it to merge past reds — which is exactly what happened, routinely, for two weeks.

The owner is the sole developer and has decided not to restore billing before launch.

## Decision

**1. `ci.yml` becomes manual-only (`workflow_dispatch`), not deleted.** Push/PR triggers are
removed so no misleading red X is produced. The file stays because it remains the contract
the local gate is graded against (see 3) and because restoration is then a one-line revert.

**2. `pnpm run gate:local` is the merge gate**, with six independently selectable legs:
`workspace` and `smoke` default on (~2 min); `e2e`, `rust`, `desktop`, `release` are opt-in;
`--all` is ~15–20 min. The user selects legs per merge at `/close-session` time, keeping the
time/assurance trade under direct human control.

The gate is deliberately a **superset** of `ci.yml`: it adds the Playwright suite (CI ran no
Playwright — a standing next-steps gap) and the `apps/server` smoke leg (which carries the
byte-exact `RUNNER_CSP` assertion CI never invoked — threat-model R-11).

**3. Drift from `ci.yml` is a test failure, not a discovery.** `scripts/gate-local.mjs`
carries a narrow purpose-built extractor for `jobs.*.steps[].run`, and a test asserts every
CI step maps to a local leg. Extra local legs are allowed; a CI step with no local
counterpart fails. Without this the local gate silently rots behind the workflow it replaces.

A `yaml` dependency was rejected: the repo has none, and adding a parser to read one file we
own and control is more surface than the job needs.

**4. The gate may never report a false green, and may never overclaim.** Two distinct
properties, because with selectable legs the second does not follow from the first:

- A leg that failed, or that was *selected but could not run* (Rust toolchain absent;
  `appIsPresent()` false, which silently converts 10 of 15 e2e specs into skips), fails the
  whole run. There is no "not applicable" success path.
- A partial run prints `PARTIAL PASS`, enumerates the legs it did NOT verify, and explicitly
  denies `ci.yml` equivalence. Only `--all` may claim equivalence — and even then it
  discloses the Windows leg, which has no local counterpart at all.
- `DESELECTED` is a third state, never conflated with `PASS`.

**5. Windows is unmonitored, and that is accepted through 1.0.** The `ci.yml` Windows leg
cannot run on macOS. Per ADR-0021 D8 the desktop shell ships macOS-only through 1.0, and
build enforcement is pinned by `bundleTargets.test.ts` — but the Windows leg staying red was
the only detector for an R-5 regression, and that detector is now gone. Named in the gate's
own `--all` verdict rather than left implicit.

**6. Restoration is required before flip-public.** An outside contributor's PR cannot be
gated by a command that only runs on the owner's Mac. The restore steps are in `ci.yml`'s
header and in `docs/next-steps.md`.

## Consequences

- The merge gate's coverage is now **per-merge and variable**. `gate:local` green no longer
  implies "CI would have been green" unless `--all` was used. This is why the verdict's
  NOT VERIFIED line is carried verbatim into the PR body and the task journal: otherwise
  `git log` becomes a uniform wall of merges whose actual verification varied invisibly.
- `/close-session` merges automatically on a green gate (owner decision), so the fail-loud
  property in (4) is load-bearing for the repo's history. It is mutation-tested.
- The e2e suite had to be made adoptable first: 8 pre-existing failures on clean `main`.
  Four were fixed (all test defects — a display-name change that broke tile lookups, and a
  ~500 ms race on the run surface's connect CTA); four pre-existing DEGRADED rows are
  quarantined with `test.fail()` rather than `test.skip()`, so a row that starts passing
  FAILS the suite and forces the quarantine to shrink deliberately rather than rot.
