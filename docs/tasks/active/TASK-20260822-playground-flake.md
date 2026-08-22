# TASK-20260822-playground-flake: the playground flake was two racy waits, not contention

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: Low — two test files' synchronization; no production code touched.
- **Branch**: `fix/TASK-20260822-playground-flake`
- **Packages touched**: `apps/playground` (tests + vitest config comment)
- **Spec impact**: none
- **Related**: ADR-0041 (the merge gate this red blocked), `docs/next-steps.md` 2026-08-19 flake entry (**this supersedes its proposed remedy**), TASK-20260822-desktop-app-shell-timeout (sibling red, different cause), TASK-20260822-wa-authstate-corruption (blocked behind it)

## Spec (what & why)

The playground suite failed intermittently — a **different** test each time, always in a rendering
or async suite, always green when run alone. Measured on clean `main`: **2 of 6** full runs red.
It blocked the merge gate's `workspace` leg.

The standing 2026-08-19 classification called it FILE PARALLELISM and proposed raising
`testTimeout` and capping `maxThreads`. **That hypothesis is wrong.** Both knobs were applied and
measured here: the rate did not move (2/6 → 2/8). So they were reverted rather than kept — an
ineffective config change is worse than none, because it reads as a fix that holds and stops
anyone looking further.

The actual cause, found by capturing the failure text instead of the failure count: **two tests
synchronized on a fixed wall-clock wait instead of on the condition they assert.**

1. `sidecarLive.test.ts` — "backs off exponentially": drives an async pump, then
   `await setTimeout(20ms)` and asserts four recorded backoff sleeps. Any scheduling delay and
   only two or three exist; the assertion then reports a backoff bug that is not there.
2. `starterInstall.test.tsx` — `settleUntil` polls the right condition but budgets by ATTEMPT
   COUNT (100 × 5 ms). Each interleaved `act()` can itself take tens of ms under load, so the real
   budget shrank exactly when it needed to be largest.

Load only ever set the odds. The races were in the tests.

**Acceptance criteria**:
1. Both tests wait for what they assert on, with wall-clock deadlines that still fail a genuinely
   stuck subject and name what never happened.
2. Full playground suite: **0 failures in 10 consecutive runs** (baseline 2 in 6).
3. `gate:local --all` GREEN.
4. No assertion weakened — no test's claim changes, only how long it may take to make it.

**Out of scope**: any other suite's timing; the vitest pool knobs (measured ineffective here).

## Plan

Fix both waits, revert the ineffective config knobs (leaving a comment recording the measurement so
the wrong hypothesis is not retried), measure over 10 runs, then the full gate.

## Decisions & surprises

- 2026-08-22: **The first fix made it worse — 9 of 10 red.** Waiting for THREE backoff sleeps
  exited before the fourth (the post-success reset) the same test asserts on. A wait condition must
  cover every assertion that follows it, not just the first. Caught by measuring the rate after the
  change instead of trusting an isolated green.
- 2026-08-22: An isolated re-run cannot distinguish "fixed" from "got lucky" for a 1-in-3 flake.
  Every claim here is a rate over ≥6 runs, before and after.

## Session journal (append-only, newest last)

### 2026-08-22 — Jeetu/Claude — session
- Done: diagnosed (captured failure TEXT, not counts), fixed both waits, reverted the ineffective
  knobs, measured 0/10 against a 2/6 baseline.
- State: running the full gate.
- Next step: gate green → PR → merge → unblock #114.
- Open questions: none.
