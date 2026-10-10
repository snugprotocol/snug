# TASK-20261009-scheduled-run-open-app: a scheduled *Run [app]* runs whether or not the app is open

- **Status**: in-progress
- **Owner**: Claude (owner-requested 2026-10-09)
- **Risk tier**: medium (Playground logic; no runner/sandbox/auth change — the hidden frame and its refusing gate are unchanged)
- **Branch**: `feat/TASK-20261009-scheduled-run-open-app`
- **Packages touched**: `apps/playground` (schedule executor), `packages/knowledge` (KB 85 wording), docs
- **Spec impact**: none
- **Related**: ADR-0074 §3/§4/§6 (amended here); TASK-20261009-scheduling-framework (done — PR-B Gate-5 fold S1 "presence is not consent"); threat model R-62

## Spec (what & why)

The owner scheduled the weather starter (*Should I?*) and the run fired on time but answered "the app is open — Snug doesn’t run it behind you; close it or run now". The owner's decision (2026-10-09): **a scheduled job runs on time, without asking, whether or not the app is open.** PR-B's Gate-5 fold refused an unattended run of an OPEN app because the first cut delivered it to the LIVE frame under the page's ordinary confirm gate (a remembered or armed grant could approve an unattended write, and the calls were uncounted). This task keeps that fix's substance and drops its refusal: a `due` / `late` / `catch-up` run ALWAYS runs in the hidden frame — the standalone refusing gate, the counting transport, the committed version — even while the app is on screen, and opening the app mid-run no longer interrupts it. The live frame is still never driven by a timer. Unchanged: a mutating connected call inside an unattended run is still refused by name (*needs you*) — writes without the user stay out of scope (the propose/approve/freeze doctrine; standing approvals are a separate decision). The user's own *Run now and review* still opens the app and runs in the live frame.

**Acceptance criteria** (each becomes at least one test):
1. A `due`, `late` or `catch-up` run of an app that is OPEN mounts the hidden frame (refusing gate, counting transport, committed html) and records the app's result — never `APP_OPEN_REFUSAL`, never the live frame's hint. → `appRunHandshake.test.tsx`.
2. Opening the same app while its hidden run is in flight does NOT interrupt the run: no `interrupt('app opened')`, the result lands. → `appRunHandshake.test.tsx`.
3. A mutating call in that run is still refused by the scheduled gate and the step is `refused` → *needs you*, open app or not. → `appRunHandshake.test.tsx` / existing gate rows stay green.
4. A `manual` run is unchanged (live frame when open; refused "open <app> and run it again" when not). → existing rows stay green.
5. Docs: ADR-0074 amendment, threat model (R-62 rewritten + the two-instances residual), delta re-hashed, KB 85 says a handler may run while the app is also open, glossary/architecture sentences; `gen:content`.

**Out of scope**: running a scheduled MUTATING call without the user (standing approvals per schedule — ADR-0033's arm; a separate owner decision); a lock between the two app instances.

## Plan

Tests first in `appRunHandshake.test.tsx`: replace the S1 describe (open → refused) with "open → hidden frame runs and answers", replace the F5 describe (open mid-run → interrupted) with "open mid-run → not interrupted, result lands", add the open-app mutating row. Then `appRun.ts`: drop the `live` refusal for non-manual triggers and the abort-on-open subscription; delete `APP_OPEN_REFUSAL`; rewrite the header comment. `engine-types.ts` / `acts.ts` comments. KB 85 + `gen:content`. ADR-0074 amendment; threat model §5 row + R-62 + new residual; delta re-hash; glossary; architecture; next-steps; lessons; memory (owner decision). Gates: playground suite + tsc, knowledge, threat-model checker, playground e2e schedule specs, `gate-local` 4 legs. Fresh-context AI review of the diff before the PR.

## Decisions & surprises

- The accepted residual: two instances of the same app (the visible one and the hidden one) can run at once over the app's one store. Each db/kv request is atomic at the host; the race is app-level (two read-modify-writes). Same shape as the app open in two tabs. The KB tells handlers to read and write through the store and stay idempotent by `runId`.

## Session journal (append-only, newest last)

### 2026-10-09 — Claude — session
- Done: task file; branch off main `7b8020e`.
- Next step: tests first.
