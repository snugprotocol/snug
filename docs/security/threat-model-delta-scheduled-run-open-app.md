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
| **A result from the open copy** | The visible instance posts a `schedule-result` (the same app code, answering a stale or forged hint) and the host takes it for the hidden run. | The hidden run's result is bound to the hidden mount's own closure; it never subscribes to the live frame's events — `appRunHandshake.test.tsx` "a result the VISIBLE copy posts is never taken for the hidden run — only the hidden frame’s own answer settles it". |
| **Opening the app mid-run** (`appRun.ts` `runInHiddenFrame`) | The run is cut off at the moment the user arrives, so a 07:00 schedule fails whenever the user opens the app at 07:00. | No subscription to the live registry in the hidden path: the hidden frame keeps running beside the visible one until it answers, times out or is cancelled. Pinned by `appRunHandshake.test.tsx` "a RunView mounting the same app mid-run does NOT interrupt it: no `interrupt`, the hidden frame stays, the result lands, the key is cleared". |

## Accepted residuals

- **R-a. Two instances of one app run at once over the app's one store — and ONE connection.**
  While the app is open, the hidden frame is a second instance of the same app, and both reach
  the SAME sql.js connection (the driver caches one per namespace). A single request is atomic at
  the host, so nothing is torn; but connection state spans requests: a transaction one instance
  opens would capture the other's writes (the visible copy's ROLLBACK swallowing a scheduled
  INSERT; a scheduled BEGIN failing inside the visible one's), and a whole-database import would
  swap the store out from under the other. **Closed for the scheduled side:** the hidden frame's
  db binding (`apps/playground/src/schedule/scheduledDbDriver.ts`) refuses BEGIN / COMMIT / END /
  ROLLBACK / SAVEPOINT / RELEASE and `import` by name with the existing `FORBIDDEN_STATEMENT` — so
  a hidden run never holds a transaction open, even one a crash would strand — pinned by
  `apps/playground/src/__tests__/scheduledDbDriver.test.ts` and `appRunHandshake.test.tsx` "the
  hidden run’s db binding is the scheduled guard: a BEGIN is refused by name, a plain read passes".
  **Still open:** the VISIBLE copy may open a transaction (its ordinary binding) that a scheduled
  single-statement write lands inside, and the visible copy may blind-write state it cached at
  load over what the handler stored. This is NOT the two-tabs case — `userdb/locks.ts` makes a
  second tab read-only, so two tabs never write at once; this is new. No shipped starter uses a
  transaction, and the weather handler only reads. *Bounded by:* the refusing gate (no unattended
  write leaves the machine); one hidden mount at a time; the knowledge base's handler rules (one
  statement per change, re-read before writing back, idempotent by `runId`).
- **R-b. A hidden run's auth failure surfaces in the open copy.** A 401/403 inside the hidden run
  sets the same repair state the visible RunView reads (`state/net.ts`), so the reconnect chip can
  appear on the open app for a call the user did not make. Benign — the connection IS broken —
  and unexplained on screen.

## What this delta does NOT claim

- It does not let an unattended run make a mutating connected call: the refusing gate is
  unchanged and such a run still reads *needs you*. Standing approvals per schedule remain out of
  scope.
- It does not add a lock between the two instances of an app.
