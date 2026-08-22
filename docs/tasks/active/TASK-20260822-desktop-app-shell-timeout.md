# TASK-20260822-desktop-app-shell-timeout: the desktop app-shell test's budget matches its work

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: Low — one test's timeout; no production code, no package touched beyond `apps/desktop`'s test file.
- **Branch**: `fix/TASK-20260822-desktop-app-shell-timeout`
- **Packages touched**: `apps/desktop` (test only)
- **Spec impact**: none
- **Related**: ADR-0041 (the local merge gate this red blocked), TASK-20260822-wa-authstate-corruption (found it), `docs/next-steps.md` playground file-parallelism flake entry (same family)

## Spec (what & why)

`gate:local --all` failed on `main` with `desktop#test → app-shell.test.tsx` timing out at 5000 ms.
Found while gating an unrelated sidecar branch; **reproduced on clean `main` (`2449990`)** with that
branch checked out nowhere, so it is `main`'s red, not the feature's.

Not a regression and not a hang. That one test resets the module graph, dynamic-imports the entire
playground `App`, boots a sql.js-backed user DB and renders React through it: ~1.1 s alone, ~3.5 s
under partial load, and over 5 s when `turbo run test` runs every package's suite concurrently —
which is precisely how the merge gate invokes it. The 5 s ceiling is vitest's inherited default;
nobody ever chose it for this test.

The cost of leaving it: the gate's verdict is the only thing standing between a commit and `main`
while CI is billing-blocked, and a gate that is red for a reason everyone learns to wave through
stops being a gate.

**Acceptance criteria**:
1. `app-shell.test.tsx`'s expensive test carries an explicit budget sized to its work (20 s), with a
   comment stating what it does and why the default was wrong — so the next reader does not "tidy" it back.
2. The full workspace leg (`pnpm exec turbo run test --force`) passes on this branch — the contended
   condition that actually failed, not just an isolated re-run.
3. `gate:local --all` reaches GREEN.

**Out of scope**: the playground file-parallelism flake (`docs/next-steps.md`, 2026-08-19 — same
family, different cause: that one needs `maxThreads` capping and ~20 confirmation runs); raising
timeouts anywhere the suite is not demonstrably load-bound.

## Plan

Single edit to `apps/desktop/src/__tests__/app-shell.test.tsx`: `it(…, 20_000)` plus the explaining
comment. Verify by running the full workspace leg (the contended path), then the full gate.

## Decisions & surprises

- 2026-08-22: A per-test budget beat a config-wide `testTimeout` — the cost is one test's, and
  putting the number where the work is documents itself. No repo precedent existed either way.
- 2026-08-22: The failure only appears under FULL-workspace concurrency. Running the desktop suite
  alone (175/175, three consecutive times) or three packages together both pass — which is how a
  load-bound timeout hides from every check short of the real gate.

## Session journal (append-only, newest last)

### 2026-08-22 — Jeetu/Claude — session
- Done: reproduced on clean `main`, fixed the budget, task file written.
- State: verifying the workspace leg, then the full gate.
- Next step: gate green → PR → merge, then merge #114 behind it.
- Open questions: none.
