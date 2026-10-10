# 0077 — One instance per app: a scheduled or on-demand run executes where the app lives

- **Status:** proposed (TASK-20261010-host-broker PR-1, 2026-10-10; owner-delegated — Q5–Q7 of the task file are the defaults taken here, each reversible by one word). Becomes `accepted` when PR-1 merges; the same commit sets ADR-0074's status to `accepted (amended by 0075, 0077)`.
- **Date:** 2026-10-10
- **Task:** TASK-20261010-host-broker
- **Amends:** ADR-0074 §4's Gate-5 fold ("a run the user did not start never rides an open app — presence is not consent") and its 2026-10-09 amendment ("an unattended *Run [app]* always runs in its own hidden frame … beside a visible copy if there is one, never in the live frame"). The principle stands; the mechanism changes: a run rides the live frame only under a gate that asks the present user and never a remembered approval. Retires threat-model R-70 for the delegated case (the headless case has no second instance to collide with).
- **Relates to:** ADR-0074 §5/§6 (the executor, the refusing gate, the counting transport, the ceilings — all kept for the headless path), ADR-0033 (the standing gate a delegated run must NOT consult), ADR-0062 (module stores outlive views — the placement store), ADR-0076 §6 (a refresh is a run and uses this placement).

## Context

The owner saw a scheduled job run while the app was open and a second copy of the app appear beside it (2026-10-10): "it struggles and tries to instantiate another db copy, which is not the right approach." Read from the code:

- `executeAppRun` (`apps/playground/src/schedule/appRun.ts:311-319`) chooses on the trigger alone: `manual` → the live frame (no announce wait, uncounted, the page's ordinary gate); `due`/`late`/`catch-up` → a hidden `SnugAppFrame` ALWAYS, open app or not. Two instances of one app then share ONE sql.js connection; the hidden one's binding refuses transactions and imports (`scheduledDbDriver.ts`), the visible one's does not — threat-model R-70 and the open-app delta's R-a. A hidden run's 401 lights the open copy's reconnect chip (R-b).
- The Gate-5 fold that put the hidden frame there guarded a real hazard: the live frame's net handler is bound at COMPOSE time to the standing→session gate chain (`state/net.ts:340,360`; `run/appRuntime.ts:120`; RunView passes no gate), so a timer-driven run on the live frame could have a remembered or armed approval answer an unattended write. "Presence is not consent" (lesson `:211`) is right. The hidden frame was the mechanism, not the principle.
- The live registry (`state/appHosts.ts`) registers on MOUNT, before the frame announces, with no generation and no readiness; *run now* navigates then hints before the app's listener exists — a 90 s `failed`.
- The knowledge base already requires scheduled handlers to be idempotent by `runId` and warns "you may not be the only instance" (`85-scheduled-runs.md:106-136`).
- The host kit and the desktop render the playground's `App`, so one engine runs everywhere; `ScheduledRunHost` is mounted once at `App.tsx:360`.

## Decision

1. **One instance per app, per host.** At any moment an app has at most one running instance on this host: the visible frame when the app is open, a headless frame otherwise, or none. Two frames of one app never share the connection again.

2. **Placement is the host's, by one rule.** `schedule/runPlacement.ts` decides for every unattended run and every on-demand run (a refresh, ADR-0076 §6): the app is LIVE and ANNOUNCED for the current generation → **delegated** to the live frame; otherwise → **headless** (today's hidden path, unchanged: the refusing gate, the counting transport, `scheduledDbDriver`, the generation-0 session-grant rule). Host-native work (ADR-0076 §9) needs no frame and does not enter placement.

3. **A delegated run rides a run-scoped ask gate.** The live frame's net handler is composed once with a gate that consults a module store PER REQUEST: while a run is in flight for this app, a mutating connected call skips the session-remember AND the standing gates and goes to the ordinary confirm dialog with the schedule's name in the copy ("*Morning forecast* — a scheduled run — wants to POST to …"); no answer within 60 s → `NET_CONFIRM_DENIED` → the step is `refused`, *needs you*. Outside a run the ordinary chain applies unchanged. GET and HEAD never reach a gate, as today. A human clicks, or nothing happens — presence is still not consent.

4. **Counting follows the run.** Calls on the live frame while a run is in flight are counted on the run row (`calls.ai`, `calls.net`), never refused mid-run; the day's ceilings are enforced BEFORE dispatch (`capped` without dispatch). A user's own click inside the ≤ 90 s window may be over-attributed; accepted and disclosed. Auth-shaped failures inside any scheduled run are attributed to the run, and the reconnect chip says so (R-b closed).

5. **A run follows the app.** Opening the app while a headless run is in flight cuts it `handed-over` and re-dispatches the SAME `runId` to the live frame once it announces; closing the app mid-delegated-run re-dispatches headless. At most one handover per run; the kv input is written once per dispatch and cleared once at the end; the KB's idempotency rule is what makes this safe, and its text now says why ("one instance — a run may be handed over").

6. **Readiness is explicit.** Registry entries carry `{generation, announced}`; RunView marks `announced` from the announce; a delegated hint waits for it ≤ 10 s (the hidden path's own bound) else `no-handler`. The *run now* race closes with it.

7. **What stays.** `ScheduledRunHost`, `scheduledDbDriver` (cheap defence against a crash-stranded transaction), `scheduledConfirmGate` and `scheduledTransport` for the headless path; the hidden frame's generation-0 rule (D30, R-78); `manual` runs ride the live frame under the ordinary gate exactly as today (R-62).

## Alternatives considered

- **Keep the hidden frame beside the open copy (today).** Honest about the gate but two instances over one connection (R-70) and the UI the owner rejected. Rejected.
- **Refuse unattended runs while the app is open (PR-B's S1).** The owner reversed it on 2026-10-09 for a reason: a 07:00 schedule must not fail because the app is open at 07:00. Rejected.
- **A lock between the two instances.** Serialises statements but not intent (a visible transaction still captures a scheduled write), and keeps the second copy. Rejected.
- **Recomposing the live frame's handler per run.** The runtime is composed once with the frame; a swap mid-session is a remount. Rejected for a gate that consults a store per request.
- **Letting the delegated run use the page's remembered approvals.** The hazard the Gate-5 fold named. Rejected.
- **Waiting for a headless run to finish before the app opens.** Up to 90 s staring at a chip. Rejected for handover.

## Consequences

- Positive: the owner's R2 verbatim; R-70 retires for the delegated case and R-b closes; one copy of an app ever touches its data; the user sees at most a run-header chip ("running *Morning forecast*…") and, for a write, a dialog that names the schedule.
- Negative / residuals (the delta names them): a delegated run spends the user's brain and network in the open app's name (counted, capped before dispatch); over-attribution of a user's click during a run; a handover costs one re-dispatch and relies on idempotent handlers (the KB rule, now explained); a user who declines the dialog gets *needs you* exactly as before.
- Docs owed: ADR-0074 status + this amendment line; `docs/threat-model.md` R-62 and R-70 rewritten and a new delta; lessons `:211` amended; KB 85 rules + the SDK header; architecture + code-map + glossary (*delegated run*, *headless run*, *handover*, *placement*).
