# Threat-model delta — host-native jobs and the task write authority: a schedule may look things up, and may make its own app's changes on its own, with an undo

**Task:** TASK-20261010-host-broker (PR-4) · **ADR:** [0076 §9](../decisions/0076-host-as-broker-access-everywhere.md) (amending [0074 §5, §6, §8](../decisions/0074-scheduling-framework.md), [0033](../decisions/0033-armed-auto-reply-standing-write-approval.md), [0026](../decisions/0026-connection-relative-addressing.md)) · **Spec:** 1.2 — a STAGED editorial revision (§8.1's `ownUndo:` key, §24.5's own-app sentence, §25); no frame, schema or wire change · **Date:** 2026-10-12

Until this change an unattended *Ask [app]'s AI* step was one tool-free call on the app's own
transport, and every data change it offered waited, pending, for the user (ADR-0074 §5–§6).
ADR-0076 §9 changes two things. First, the step may carry *let it look things up*
(`tools: true`): the host itself — the app never opens — runs ONE bounded agent turn over three
tools, `data_query` (the app's own data, and the tables the user let it read from other apps
while away), a scheduled `data_propose_write`, and `fetch_connection`, a GET through the app's
approved connections. Second, the user may let a schedule **make its changes on its own**: a
task whose app steps all name ONE app carries a `writeAuthority`, armed by the user's tick on
the one consent surface, and at the end of a finished run the host makes what the run proposed
to THAT app's own data — at most 200 rows a run, through the Write Broker's capture seat, each
change journaled as rows so the user can put it back for seven days. The user's own approvals
of a change (the chat's card, a result page) now go through the same capture seat and the same
journal, so they too can be undone. A scheduled step still never writes ANOTHER app's data
(policy rule 4′; spec 1.2 §24.5 item 18): an authority over another app's data is its own
future task. C1 and C2 are unchanged in policy: the credential is injected by the executor and
never reaches the model, every string a fetch returns is scrubbed before the model reads it,
and no frame, sandbox or CSP byte changes (the agent and the walk are host-side; nothing new is
posted to a frame). What follows are the channels those policies must survive.

## What is new

| Surface | The threat | What holds |
|---|---|---|
| **The scheduled agent** (`schedule/appAgent.ts` `executeAppAgent`; `agent/gatedAdapter.ts`; `agent/dataTools.ts` `capToolCalls`; `schedule/executors.ts` the gates and the LAZY import; `packages/knowledge/prompts/system/50-scheduled-agent.md`) | An unattended tool loop spends without bound, runs on a brain that cannot hold it (a demo script answering a person; a brain with no data lane), outlives the run's bound with its calls uncounted, or answers under the app-runtime JSON doctrine; the host kit, whose brains cannot run it, carries it anyway. | ONE `runAgentTurn` per step: at most `APP_AGENT_MAX_ROUND_TRIPS` (10) round trips and `APP_AGENT_MAX_TOOL_CALLS` (8) tool calls on ONE shared counter (the ninth answers the cap sentence). Every AI call asks the day's ceiling AT the adapter (`gatedAdapter`: the file's counters for the day + what the run spent + what this step spent + 1) — no headroom answers `CAPPED` and the inner adapter is never called; F15's `CONSENT_REQUIRED` is uncharged. The step stops itself `APP_AGENT_DEADLINE_MARGIN_MS` (30 s) before the queue's bound and answers with the calls it spent; the turn's signal reaches a fetch already in flight; a late outcome's calls are folded into the day. Gates in the production executor, on BOTH paths: the demo override or a keyless BYOK brain is refused by name (`blockedBy: 'brain'`); a brain with no data lane, or an app holding a live sidecar fact, degrades to the tool-free step with `tools: {unavailable}` on the result; the agent re-reads the brain route immediately before building its adapter and builds the adapter FROM it. The system is host identity + the scheduled-agent layer + the app's runtime contract as the END suffix — never layers 45 or 40. The stored answer is the FINAL round's text, scrubbed. The kit swaps the module for a loud stub (no kit brain opens the data lane — pinned). |
| **`data_query` inside the turn** (`agent/dataTools.ts`, the scheduled seat; `access/service.ts` the schedule door) | The agent reads another app's data beyond the user's away consent, or reads it without a record; its scratch copy discards the app's open transaction. | The shared tables are the scheduler door's: persisted grants ticked *also while I'm away* only (R-78). They are named in the first message by NAME only — rows arrive only through `data_query`, and a statement that names one records the `read` line (the schedule caller, the grant, the statement) BEFORE its rows reach the brain; the step's `saw` names each table read on the result. `inTransaction(app)` is asked before any scratch copy is exported — an app mid-change answers the busy sentence and the statement never runs. |
| **`fetch_connection`** (`agent/fetchConnectionTool.ts` `buildFetchConnectionTool`, `fetchableConnections`; `packages/knowledge/prompts/tools/fetch-connection.md`) | The model writes a method, a body or a URL; a multi-host (OAuth) connection lets a path name another approved host (the WHATWG parser strips tab, LF and CR, so `/\t/evil.example/a` lands on `evil.example`) or a host a pending requirement only proposed; a failure message carries a host; the helper or a LAN device is reached; shared rows ride a query string; a response carries the injected credential back to the model, transformed. | The input is EXACTLY `{connection, path, query?}` — a `method`, `body`, `headers` or `url` the model adds is never read, and the executor is always asked for a GET with no body (the scheduled confirm gate is the belt, never reached). A one-host connection resolves symbolically (`snug-connection://<slot><path>`, ADR-0026); a multi-host one composes `https://<apiHost><path>` where `apiHost` is the ONE host the APPROVED requirement declares (never `pendingRequirement`'s) and is in the row's frozen ceiling — and the tool asserts the composed URL's host BEFORE the executor, because ADR-0026's guard runs only on the executor's symbolic branch. `path` is `^/(?!/)[!-~]*$` with no `?`, `#` or `\`, ≤ 2,048; `query` goes through `URLSearchParams`. Refused by name before the executor: an app that may not reach the network, an unknown or unapproved row, a sidecar-class slot, a LAN-class row, a row with no single address — and the deps carry no `sidecarFetch`, `lanFetch` or private-http policy at all. A composed-path failure is answered by a fixed sentence naming the slot, never the host. Each call asks the day's NETWORK counter first (read directly, never behind an AI-first answer) and is counted then. **The taint:** once the turn has recorded a read of another app's data, every further fetch answers *not after reading another app’s data in this run* (fetch-then-read stays allowed). Every string returned passes `scrubOrWithhold(…, 'deliver')` before the cut and is withheld whole when still credential-shaped; the body is framed at `FETCH_CONNECTION_MAX_CHARS` (16,000) including the frame. The request bound is 20 s, inside the 30 s margin. The result names each connection used, by slot, with a count — never a path, a query or a host (`tools.fetched`). |
| **The one proposal gate, both executors** (`schedule/proposalGate.ts` `gateProposal`; the scheduled `data_propose_write` and its own definition `data-propose-write-scheduled.md`) | A change that cannot be what it says sits on a result or is made on its own: a second statement, DDL, a subquery reaching every table; a placeholder bound to NULL by every later run of it; a credential; a dry run that discards a live transaction; another app's table. | Five questions in order, nothing past a refusal runs: the item schema (ONE INSERT/UPDATE/DELETE over literal values — `isSingleDmlStatement`); no unbound placeholder (`?`, `?N`, `:v`, `@v`, `$v` outside quoted text and comments); no credential (`findScheduleCredential`); `inTransaction` before any export; a dry run on a throwaway copy that attaches no other app's tables (a shared name is "no such table"). At most three a run, the run's pooled count reaching each step. The scheduled tool's own definition offers ONE statement and no `params` property; the chat's is byte-identical to before. Another app's table is refused by name exactly as the chat refuses it. Every *Proposed* answer ends *never say a change was made — say what you proposed; the host reports what it made*; under an armed schedule a change `ownCapturable` refuses is answered with the rule and how to write it so it could be made. |
| **The task write authority** (`schedule.ts` `writeAuthority {rowsPerRun, armedAt, armedVersion}`, `disarmed {reason, at}`; `schedule/acts.ts` `armTask`, `disarmTask`, `disarmAllTasks`, `updateTask`; `schedule/taskShape.ts` `armableAppOf`, `widens`, `installedAfterArming`) | A standing permission to change data is planted, seeded or smuggled (a proposal channel, an app's suggestion, an import, a draft); it outlives what the user consented to (new code under the same app, a reinstall under the same id, a wider schedule); it spans two apps; nobody can see it or stop it. | Written by ONE act, `armTask` — the consent's tick (OFF on every mount, never seeded) or the editor's *changes it suggests: make them on its own* through the consent — and only for a schedule that asks one app's AI and whose every app step names that app (one seat call, one bucket, one app's data a run); `rowsPerRun` is 200, `armedVersion` the app's CURRENT version; refused for a task whose id spells the approvals' bucket and for an app installed after the consent's instant. The record is strict (no seat can name another app, a table list or a standing approval); no proposal schema has a seat for it; `createTask` and `updateTask` never copy one from their input. **Taken away by:** a widening edit (the steps, compared schema-parsed and canonical; the owner app; a shorter minimum gap) unless the same save passes the consent; the app's version changing from ANY source — the user's own edit, a revert, a reset, a starter update included — proactively in the one fan-out (`onAppVersionChanged`, never thrown at the update) and by the walk's `armedVersion` belt (a version that arrived by a trusted pull); deleting the app; every untrusted import; the row's *stop making changes on its own*; Settings' *stop every schedule making changes on its own*. A disarm the user did not perform leaves a `disarmed` trace the row shows until the user reviews it. Shown wherever the task is: the row's chip, the editor's control, the paused sentence, the update note. |
| **The walk** (`schedule/applyArmed.ts` `applyArmed`; `schedule/queue.ts` `settleChanges`) | A cancelled, timed-out, paused or file-swapped run applies; a failed or capped step's items apply; a change the host cannot undo is made; the budget is measured on stale counts; a stop, a pause or an update that lands mid-run is ignored; an abort leaves the queue wedged. | At the queue's pooling point, after every step, BEFORE the run row is written. Only an un-aborted run's `ok` steps' items, of the armed app only (another app's item stays pending, untouched). Order: `stillArmed` → the items PARTITIONED by `ownCapturable` (one it could not undo is held `cannot-undo` at once and never joins the batch) → `inTransaction(app)` (busy holds the rest) → the capturable items re-dry-run IN ORDER on ONE scratch copy — those fresh counts are the seat's `expectChanges` and the budget → the longest prefix whose sum ≤ `rowsPerRun` (the rest `over-limit`; an all-zero prefix never reaches the seat) → ONE `applyOwnWrite` with `requireUndo: true`, whose `stillArmed` is evaluated after its last await, immediately before the seat, from the FILE: the run not aborted ∧ the task present, on, unpaused ∧ the same `armedAt` ∧ the app at `armedVersion` and installed before the consent ∧ no global pause. The pre-seat awaits race the run's abort (an abort holds every armed item `stopped`; the run folds `interrupted`). Held reasons are ONE table (`SCHEDULE_HELD_REASONS`); a held item waits for the user like any other. The model never sees its own changes made: the walk runs after the steps answered. |
| **The capture seat** (`packages/db/src/brokered-write.ts` `{ own, capture: true, caps, expectChanges, requireUndo, admit }`, `ownCapturable`; `access/writeBroker.ts` `applyOwnWrite`, `seatOwnWrite`) | An own write lands that its journal cannot hold, or half of a batch lands; the seat interleaves with the app's own statements; a reader-oracle rule refuses the user's own change; a cell carrying a credential is journaled. | Plannability is decided for the WHOLE batch before any transaction: the literal grammar, the table's SHAPE (`tableShape` — real rowid table, no trigger, no `ON CONFLICT REPLACE`, the rules an undo re-checks) and an OWN column rule (an UPDATE/INSERT naming a credential-named column, or a DELETE on a table holding one, is unplannable; generated columns never captured) — never `tableFacts`, whose CHECK and DELETE-coverage rules are oracles against a READER. One synchronous span (`BEGIN IMMEDIATE` · the capture · each statement · `sum(changes) ≤ caps.maxChanges` after each · the drift halt · the cell rule and the byte cap · `admit(steps)` · `COMMIT`); `admit` is the bucket rule ∧ `ownUndoEntrySchema.safeParse` of the EXACT entry the engine will write, asked BEFORE `COMMIT`. Under `requireUndo` (a schedule) a no rolls back `cannot-undo`; without it (an approval) the change commits `undoable: false`, an unplannable batch re-runs WHOLE on the bare `{ own }` seat (never a mixed batch, never one transaction shared by the two), and one previewed over 200 rows takes the bare seat up front — an approval is never refused for its size or its room. `inTransaction` is asked first everywhere an own write exports a live namespace. After the commit, in one synchronous run: the entry put, the caller's record (`onCommitted`), the read caches cleared, `data-changed` to the app's own frame and `access-source-changed` to every live reader — each caught and warned, so a committed change is never reported as "nothing was changed". No access history line: `authority: 'task'` appears on no line. |
| **The own undo journal** (`ownUndo:<appId>:<bucket>`; `packages/protocol/src/own-undo.ts` `ownUndoEntrySchema`; `packages/db/src/userdb/own-undo.ts` `putOwnUndo`, `listOwnUndo`, `markOwnUndone`, `ownUndoRoom`, `ownUndoBelongsIn`) | A journal that holds statement text is a stored program; a schedule evicts the undo the user still wants; a task's entry lands in the bucket that never refuses; a planted element is listed or counted; a captured cell carries a credential at rest. | ROWS, never SQL — the access journal's step schema, step cap and per-cell credential walk REUSED (an entry the access journal refuses, this one refuses), strict at every level, no grant or reader seat; `authority` `approval` ⇔ no `taskId`, `task` ⇔ `taskId` (a refinement). One row per BUCKET: each armed schedule's (`<taskId>`) and the user's approvals' (`approval`). A schedule's bucket REFUSES at `OWN_UNDO_MAX_LIVE` (20) live entries or `OWN_UNDO_ROW_MAX_BYTES` (256 KiB) — the engine asks `ownUndoRoom` (one full entry's room) BEFORE the seat and holds the change `full`; the approval bucket NEVER refuses — its oldest live entry gives way. `ownUndoBelongsIn` is asked by the put, as a filter on every read and first in the engine, so an entry outside its bucket is never written, listed, counted or kept. Seven days; an undone entry is kept, marked, until it expires; swept by `deleteScheduledTask` (its bucket — the delete confirm says so first) and `deleteApp` (the prefix); DROPPED on an untrusted import, kept on a trusted pull. |
| **The own undo** (`access/writeBroker.ts` `undoOwnWrite`, `reverseEntry`; `access/OwnUndoAct.tsx`; the result page, the schedule's changes list, the chat card) | An undo hits rows that changed since or a schema that changed; an undo of an undo; an undo that is only findable while its result survives pruning. | The live entry of the named bucket (unknown, undone or expired → `gone`); every step's table and columns re-validated against the live schema (a mismatch, or a credential-named column, retires the entry `gone`); the inverse rebuilt from the structure with bound parameters and the after-image guard, in reverse step order, through the seat's `{ undo }` — any statement that changed ≠ 1 row rolls the WHOLE undo back. An undone entry is never offered again. No history line. The undo is findable for its whole seven days from the schedule's own changes list (the row's *history*), linked from each result; *clear history* keeps a run whose undo is still live. |
| **The run row's new seats** (`scheduleRunSchema` `applied?`, `approved?`; the item's `held?`; the step result's `inOpenApp?`, `saw?`, `tools?`, `blockedBy?`) | The record of a change made claims SQL, leaks a fetched path or query, or is dropped when the row is cut; a foreign file plants a claim of a change; R-88 — the result is silent about the shared tables. | INTERNAL shapes, each omitted when absent, so a run of an unchanged task is byte-identical to its pre-PR-4 form. `applied` is ONE group (one app, the task's bucket's `undoId` or `undoable: false`, ≤ 3 items of `{summary?, changes}`) — never SQL; `approved` one entry per user-approved item; `saw` ≤ 8 `{source, table}` names folded to one line (closing R-88); `tools` the count and the slots, never a path. `applied` is written into the claim row in the SAME synchronous tick as the undo entry (`onCommitted`); `fitRunRow` sheds summaries, then the waiting list, then step facts — never `applied` or `approved`; the minimal row keeps them. Only an UNTRUSTED import strips `applied`/`approved` (their undo ids name entries that import drops); an export, a sync push and a trusted pull keep them; `proposals` still never cross the file boundary. |
| **The user's own approvals** (`executeApprovedWrite(db, proposal, {via})`; `applyApprovedWrite`; the chat card's belt in `agent/useBuilderChat.ts`) | An approve applies under the app's open `BEGIN` (the export under the dry run discarded it — a live bug the characterisation proved); a persisted card is aimed at another app or carries a planted outcome or undo id. | The order is the class guard → `inTransaction` → the dry run's drift halt → the capture seat under the approval bucket (`via: 'chat'` or `'user'`); a busy app is `failed` with the sentence that names it, before anything is exported. The card's persisted `outcome` is re-admitted only from its list and `undoId` only as a uuid; a persisted change whose app is not the thread's pinned app is no card; *undo* is offered only while the approval bucket holds that id live. |

## What is NOT changed

- **No scheduled write of another app's data.** Policy rule 4′ (`access/policy.ts`) still refuses
  every scheduled `write` — spec 1.2 §24.5 item 18 stands; the scheduled `data_propose_write`
  refuses another app's table by name; a cross-app item can only wait for the user, and the
  user's approve of one applies it to its own app's data only. The chat door stays read-only for
  another app's data (the chat's cross-app write moved to PR-5).
- **No mutating connected call while nobody is looking.** `fetch_connection` cannot express a
  method; a *Run [app]* step's mutating call still meets the standalone refusing gate
  (`schedule/scheduledConfirmGate.ts`, unchanged). ADR-0033's standing-approval gate
  (`packages/auth/src/standing-approval.ts`) is still not armable — the task authority goes
  through the Write Broker, not that gate.
- C1: the executor injects the credential and scrubs every injected value from the response
  (R-54) exactly as before; the tool's `deliver` scrub is an additional pass over every string it
  returns. `snug_secrets` is never read by the agent.
- C2: no frame, sandbox or CSP byte changes; the agent and the walk run host-side, and an *Ask*
  step never opens the app.
- The tool-free *Ask* step, without the authority, behaves as before: one call on the app's own
  transport, every change pending. Its response schema says "never run automatically" only when
  the task is unarmed.
- The wire: no frame, capability flag, error code or published schema byte
  (`packages/protocol/schemas/` untouched). Every new shape is INTERNAL (`schedule.ts`,
  `own-undo.ts`, outside `json-schemas.ts` SOURCES); the spec text moves only as a staged
  editorial revision of 1.2 (§8.1, §24.5, §25).
- The access journal (`accessUndo:*`), the `wrote`/`undone` lines, refresh and the doorbells'
  rules are unchanged; an own write rings the same two doorbells a brokered write rings.
- Pause and resume, off and on keep an authority; nothing applies while either holds.

## Residual risks (recorded, not fixed)

- **R-98 — Fetched or shared content can steer an armed schedule's own change.** A row the user
  let the agent read from another app, a fetched response, or the app's own rows can shape the
  changes the agent proposes, and under the authority the host makes them while nobody is
  looking (R-53's shape, now landing). *Bounded by:* the schedule's OWN app's data only (never
  another app's — rule 4′); `rowsPerRun` (200) a run; the capture grammar (literal values, a
  WHERE, no function, arithmetic or conflict clause) and the journal's admission; the task's
  bucket (20 live); every change undoable for seven days from the schedule's changes list; the
  result's host line *changed 12 rows in Ledger on its own*, also in the feed, the history and a
  notification body; rows and responses delimited and restated as data.
- **R-99 — GET-only is not read-only.** An API that acts on a GET (a toggle, a webhook, a
  "mark read") can be driven by what the agent fetched or read. *Bounded by:* the app's approved
  hosts (the frozen ceiling, a multi-host connection pinned to its one declared API host); eight
  calls a run and the day's network ceiling; the taint rule; `tools.fetched` on the result; the
  consent's words — *it only asks, never posts — but what it asks can carry your data; it can use
  them without asking you each time*. What bounds it is the host's, never the model's reading of
  its tool.
- **R-100 — The taint is per turn, and own rows are not tainted.** `fetch_connection` refuses
  after a recorded read of another app's data in the SAME turn. Three channels remain: the app's
  own rows can ride a query string to its own approved hosts (as its own code always could —
  R-72's class for own data); an ARMED change can copy shared rows into the app's own tables,
  from which a LATER, untainted run can read and fetch them; and the first message names the
  shared tables (names, never rows) before any read is recorded. The optional fold making
  post-taint changes unarmable was declined: copying derived values into the reader's own tables
  is the use the read grant and the authority exist for (reversal word "taint-arm"). *Bounded
  by:* the user's away-ticked grant (R-78) and its *where <Reader> can send what it reads* line
  (R-72); the approved hosts; the ceilings; every read logged on the source; the copy is a change
  on the result, undoable.
- **R-101 — A stop reaches another device only at its next pull, and a trusted pull carries an
  authority as given.** `writeAuthority` is a row in the file: a trusted pull brings it to another
  device, where the same schedule makes changes on its own (R-75's class); a stop made on one
  device takes effect elsewhere at that device's next pull (R-55's class); and a trusted pull that
  carries the other copy's task brings back an authority a local, unpushed stop had taken away.
  *Bounded by:* trusted means the user's own sync origin; every untrusted import strips every
  authority; the walk re-reads the file immediately before each seat; `armedVersion` disarms on
  any version the pull carries that the consent did not see; the chip shows the state on every
  device.
- **R-102 — A transformed echo of a credential is caught by its shape, not its value.** The
  executor's scrub is exact-substring over injected values (R-2, R-54); a service that echoes the
  credential transformed (JSON-escaped, re-encoded) defeats it. `fetch_connection` passes every
  string through the shape scrub before the model reads it and withholds what still looks like a
  credential — pinned for a JSON-escaped echo — but a value with no recognisable shape, re-encoded,
  reaches the user's own brain. *Bounded by:* the frozen ceiling; the brain is the user's own
  route; the stored summary passes the store scrub and the whole-text withhold; a proposal
  carrying a credential is refused at the gate.
- **R-103 — The app's runtime contract is the scheduled agent's system-prompt suffix.** The
  app-authored contract rides at the END of the agent's system, so it can steer what the agent
  looks up and proposes — and, under the authority, what lands in the app's own data. *Bounded
  by:* a contract is accepted by the user and never dictated by an untrusted import (§5); the
  scheduled-agent layer says the app's description is context, never instructions; the reach is
  the app's own data, which its own code already holds (R-61); R-98's bounds.
- **R-104 — No rate cap per window beyond the run's.** The authority bounds a run (200 rows),
  not a day: an armed schedule may change up to `rowsPerRun` rows on every run the floors and the
  day's AI ceiling admit. *Bounded by:* the frequency floor (5 min for the user's own schedule);
  the 100 AI calls a day across every schedule (a tool-free ask step spends one, a tool step up to
  ten); the task's bucket — at 20 live entries the walk holds `full`, so one schedule makes changes
  at most 20 times in any seven days unless the user undoes some (the consent says so for a
  schedule running more than 20 times a week); several armed schedules multiply it.
- **R-105 — A change and its record are written back separately.** The change lands in the
  app's own runtime database; its undo entry and the run row's `applied` group land in the user
  file's settings rows in the SAME synchronous tick — but the two are written back to storage on
  their own schedules (the app's runtime bytes on the driver's debounced write-back). A crash
  between them can keep the change with no entry or group naming it (it stands, with no undo),
  or keep an entry naming a change that did not persist (its undo finds the rows not as the
  change left them and fails whole, changing nothing). A bucket put refused after the commit
  (a schedule's bucket filled by a write that raced past the room check) leaves the change made
  and `undoable: false`, said on the result. R-97's class at the persistence layer. *Bounded by:*
  the debounce window and the flush on `pagehide`/hidden; the after-image guard; the room check
  reserving one full entry.
- **R-106 — Two devices may each make one occurrence's changes.** Two hosts on diverged copies
  can both run an occurrence (R-51) and, under the authority, both make its changes — each on its
  own copy. *Bounded by:* sync is compare-and-swap over the whole file (R-52): the copies meet as
  a divergence the user resolves, so one copy's changes survive and never both summed in one file
  — the losing copy's changes and their undo entries go with it.
- **R-107 — The own journal holds the user's own rows at rest, and travels with the file.** For
  seven days the file carries, beside the tables, the before and after values of every own change
  and, for a DELETE, whole rows; the journal rides every export and every sync push. *Bounded
  by:* the rows were already in the file; never a credential (every cell walked under its column;
  a credential-named column is never captured); never statement text; the caps (20 live a
  schedule, 64 KiB an entry, 256 KiB a row); dropped by an untrusted import.
- **R-108 — A journal entry planted through the TRUSTED origin is a write on one *undo* click.**
  The user's own sync origin can carry an `ownUndo:*` row the user never made, and the user's
  *undo* then writes its rows into the app's own tables. *Bounded by:* the bucket's namespace (an
  entry acts only on the app its key names, only from the bucket it belongs in); `tableShape` and
  the live column re-check; the after-image match — nothing changes unless every row holds what
  the entry says the change left; bound parameters only, never SQL — no more than that origin's
  power to rewrite the file outright.
- **R-109 — The stop window.** `stillArmed` is the last look before the seat; a stop, a pause or
  an update that lands after it, while the seat's call is in flight, does not stop the commit —
  one run's at most `rowsPerRun` rows are made, journaled and undoable. *Bounded by:* nothing is
  awaited between the look and the seat but the seat's own call; the seat is atomic; every later
  run re-reads the file.
- **R-110 — A pre-PR-4 reader refuses what PR-4 writes.** The shapes are strict: a run carrying
  any new seat — one that ran in the open app (`inOpenApp`, every manual *run now* of a *Run
  [app]* step included), read another app's data (`saw`), used or lacked its tools (`tools`), was
  refused for its brain (`blockedBy`), made or had approved a change (`applied`, `approved`) or
  holds a `held` item — is refused by an older hub, dropped from its history and from its next
  export or push; a task carrying `writeAuthority`, `disarmed` or a `tools` step is unreadable
  there and deleted by its untrusted import (a trusted pull leaves it as an unreadable row). Fail
  closed is the direction (pinned against a hand-copied pre-PR-4 reader). *Bounded by:* a run of
  an unchanged task, and a task that never used a new seat, are byte-identical to their pre-PR-4
  form.
