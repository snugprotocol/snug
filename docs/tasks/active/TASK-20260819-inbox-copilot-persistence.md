# TASK-20260819-inbox-copilot-persistence: Inbox Copilot keeps its synced mail

- **Status**: in-review (implemented and browser-verified across a real relaunch)
- **Owner**: Jeetu
- **Risk tier**: **Low** — `examples/gmail` only. No protocol, auth, runner, or playground change; the persistence seam (`useAppDB`) is already in the byte-locked hooks block and needs no edit.
- **Branch**: `feat/TASK-20260819-gmail-starter` (continues the starter branch — owner-reported defect against unmerged work)
- **Packages touched**: `examples/gmail`
- **Spec impact**: none
- **Related**: ADR-0007 (single portable user DB, per-app namespaces), ADR-0038 (Ledger — the DB-backed starter precedent, incl. the `sample` provenance column), TASK-20260819-inbox-copilot-fixes (the refresh signal this builds on)

## Spec (what & why)

**Owner-reported:** connect Gmail, sync, close the app, relaunch — and Inbox Copilot is
back to sample data.

The cause is that the app has no persistence at all. Every synced message lives in
React state and dies with the frame; the only thing `usePersistedState` holds is the
window preference. The app never calls `useAppDB`, so nothing it learns about a
mailbox survives a close — and because `isSample` is derived from a *transient* sync
phase, an app with no rows falls back to the demo inbox, which is the flip the owner
saw.

That is wrong on Snug's own terms: the whole premise is that a user owns their data in
one portable SQLite file (ADR-0007). An app that re-downloads someone's mailbox on
every launch is not using the file, and it makes every relaunch cost hundreds of
metadata reads against a quota.

The fix is the Ledger pattern (ADR-0038): a real schema in the app's namespace, rows
carrying a `sample` provenance flag so demo data vanishes wholesale on the first real
sync, and load-from-DB on boot so a relaunch shows the user's own mail immediately.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — a schema exists and is idempotent.** `messages` (the synced metadata) and
   `sync_runs` (when, which window, how many, ok/failed). Re-running the DDL on a
   populated DB is a no-op and loses nothing.
2. **AC2 — a sync persists.** Every message the sync collects is written with
   `sample = 0`, keyed by Gmail's message id so a re-sync updates rather than
   duplicates.
3. **AC3 — a relaunch shows real mail, not the demo.** With rows in the DB the app
   loads them on boot and never renders the sample inbox; `isSample` becomes a fact
   about the ROWS (Ledger's `every(row => row.sample === 1)`), not about a transient
   sync phase.
4. **AC4 — the first real sync evicts the sample wholesale.** No mixed state: a
   mailbox is never half demo and half real, in the DB or on screen.
5. **AC5 — a failed sync keeps what was already there.** An error must never empty
   the table or revert a real mailbox to the demo — the last good data stays, and the
   failure is reported over it.
6. **AC6 — cleanup actions persist too.** Trashing 400 emails must not have them
   reappear on relaunch: rows the app moved out of the inbox are removed from local
   state AND from the DB in the same commit.
7. **AC7 — the last sync is reported.** The header states when the mailbox was last
   read and over which window, so "is this stale?" is answerable without a re-sync.

**Out of scope**: incremental `historyId` sync (still queued); storing message bodies
(the app is metadata-only by design); adopting this in other starters.

## Plan

Tests first per TDD.md.

1. RED: `gmail-analysis.test.mjs` — the DDL shape, the row round-trip (message →
   row → message), sample eviction, and the `isSample` predicate over rows.
2. `examples/gmail/app.html`: DDL + `useAppDB`; bootstrap effect (schema → load →
   seed sample only if empty); `sync()` writes rows and a `sync_runs` entry; cleanup
   deletes rows; `isSample` derived from row provenance.
3. Browser-verify the actual reported bug: sync, reload the frame, confirm real data
   survives and the sample banner stays gone.

## Session journal (append-only, newest last)

### 2026-08-19 — Claude (Fable 5) — session
- Done: Gate 1–2. Confirmed the app calls `useAppDB` nowhere; only the window
  preference persists. Ledger (ADR-0038) is the precedent, including the `sample`
  provenance column.
- State: implementing.
- Next step: RED tests, then the schema and the load/store path.

### 2026-08-19 (later) — Claude (Fable 5) — session
- Done: the app now stores its mailbox. Ledger's pattern (ADR-0038): `messages` +
  `sync_runs` with a `sample` provenance column; bootstrap is schema → load → seed the
  demo ONLY if the file is empty; a real sync evicts the demo wholesale and writes real
  rows; cleanup deletes locally as well as at Gmail; a failed sync writes only its
  `sync_runs` row and leaves the stored mailbox intact.
- TWO derivations had to move from phase to data, and the second was only visible in the
  browser: `isSample` (the reported flip) AND `connected` — after rows loaded correctly a
  returning user was still told "Sample inbox, connect Gmail". The header count came from
  `syncState.fetched`, a per-session number, so it read "0 emails" on a relaunch with a
  full mailbox; it now counts loaded rows.
- **Process failure worth recording:** one of my edit scripts asserted on two anchors and
  wrote nothing when the second failed — but printed nothing to say so, so I tested a
  binary that did not contain the change and spent several probes diagnosing a stub-host
  bug that did not exist. A multi-part edit must either be atomic-and-loud or applied one
  anchor at a time. The browser is what caught it, again.
- Verified end to end against a stub host with a REAL sql.js database that survives an
  iframe reload: seed 585 sample rows → sync 4 real ones (585 evicted, `sync_runs`
  written) → relaunch → "4 emails from the last 90 days", no sample banner, "Last read
  … · last 90 days" → then a FAILING sync, which leaves all 4 rows and the real view
  intact.
- State: examples 277/277; full uncached `turbo run test` 23/23.
- Next step: human review. Owner manual test: connect real Gmail, sync, fully close and
  reopen the app, confirm the mailbox is still there.
