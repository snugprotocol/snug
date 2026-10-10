# Threat-model delta — a scheduled *Run [app]* runs whether or not the app is open

**Task:** TASK-20261009-scheduled-run-open-app · **ADR:** 0074 (amended) · **Supersedes:** PR-B's
Gate-5 S1 refusal and F5 abort (proposals delta R-b; model R-62 as of v3.5).

The owner's decision (2026-10-09): a scheduled job runs on time, without asking, whether or not
the app is open. Until this change an unattended run (`due`, `late`, `catch-up`) of an app that
was ON SCREEN was refused by name ("the app is open — Snug doesn’t run it behind you") and read
*needs you*, and opening the app while its hidden run was in flight interrupted the run (`app
opened`). Both are retired. What the S1 fold actually guarded against is kept: the timer still
never drives the LIVE frame.

## What is new

| Surface | What could go wrong | What holds |
|---|---|---|
| **An unattended run of an OPEN app** (`schedule/appRun.ts` `executeAppRun`) | The run reaches the live frame and so the page's ordinary confirm gate — a remembered session grant or an armed standing grant approves an unattended write, a confirm pops because a timer fired, and the calls escape the day's ceilings (the hazard PR-B's S1 named). | A `due` / `late` / `catch-up` run ALWAYS mounts its own hidden `SnugAppFrame` — the same component, sandbox and CSP — with the STANDALONE refusing gate and the counting transport, open app or not; the live frame is never hinted by a timer. Only a `manual` run (the user's own *Run now and review*, which opens the app first) rides the live frame. Pinned by `apps/playground/src/__tests__/appRunHandshake.test.tsx` ("due / late / catch-up with the app LIVE → the hidden frame mounts under the scheduled gate, the live frame is never hinted, and the app’s result is recorded"; "a mutating call in that run is still refused by the scheduled gate → `refused` with the needs-you sentence, app open or not"; "the old open-app refusal is gone from the executor’s exports"). |
| **Opening the app mid-run** (`appRun.ts` `runInHiddenFrame`) | The run is cut off at the moment the user arrives, so a 07:00 schedule fails whenever the user opens the app at 07:00. | No subscription to the live registry in the hidden path: the hidden frame keeps running beside the visible one until it answers, times out or is cancelled. Pinned by `appRunHandshake.test.tsx` "a RunView mounting the same app mid-run does NOT interrupt it: no `interrupt`, the hidden frame stays, the result lands, the key is cleared". |

## Accepted residuals

- **R-a. Two instances of one app may run at once over the app's one store.** While the app is
  open, the hidden frame is a second instance of the same app. Each db and kv request is atomic
  at the host and both instances go through the same value-blind seams, so no request is lost or
  torn; the race is the APP's — two read-modify-writes, or the visible instance holding state the
  hidden one changed until it re-reads. The same shape as the app open in two tabs. *Bounded by:*
  the refusing gate (no unattended write leaves the machine), the queue's one-step-at-a-time
  hidden mount, and the knowledge base's handler rules (idempotent by `runId`, read and write
  through the store, never assume this is the only instance).

## What this delta does NOT claim

- It does not let an unattended run make a mutating connected call: the refusing gate is
  unchanged and such a run still reads *needs you*. Standing approvals per schedule remain out of
  scope.
- It does not add a lock between the two instances of an app.
