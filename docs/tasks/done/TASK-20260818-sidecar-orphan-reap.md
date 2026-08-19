# TASK-20260818-sidecar-orphan-reap: WhatsApp helper singleton — reap orphans, die with the shell

- **Status**: done (merged 2026-08-19, PR #73, squash `a8bd416`)
- **Owner**: jeetu
- **Risk tier**: low (owner-set at interview; kill-path still gets tests first — the verify-before-kill verdict is pure and cheap to pin)
- **Branch**: `fix/TASK-20260818-sidecar-orphan-reap`
- **Packages touched**: `apps/desktop` (src-tauri `sidecar.rs`), `apps/whatsapp-sidecar`
- **Spec impact**: none (no `packages/protocol` change anticipated)
- **Related**: ADR-0032 (sidecar seam), ADR-0037 (durable sync + autostart + shell-exit shutdown), solutions/2026-08-17-eight-seam-defects

## Spec (what & why)

On desktop-client start the terminal fills with a Baileys `Stream Errored (conflict)` /
`stream:error … conflict type=replaced` loop. Observed live: TWO helper processes were
running against the same Baileys auth store — pid 60490 (started 18:23, **ppid 1: orphaned**)
and pid 50057 (22:41, child of the current `target/debug/snug-desktop`). WhatsApp allows one
live connection per linked device, so each helper's login "replaces" the other's stream and
they ping-pong forever.

The 2026-08-18 `shutdown()` fix (ADR-0037) reaps the helper on **clean** shell exit only.
Nothing handles an **unclean** one — a killed/crashed shell (or a `tauri dev` rebuild, which
SIGKILLs) orphans the helper; the next launch spawns a rival. This task makes the helper a
true singleton: the shell reaps any stale helper before spawning, and the helper exits on its
own when its parent dies.

**Acceptance criteria** (each becomes at least one test):
1. Helper: when its spawning parent dies (reparent to pid 1 / ppid change), the helper runs
   the same clean shutdown as SIGTERM (final thread-cache flush, socket removed, exit 0).
2. Shell: after a successful spawn, a pidfile exists beside the socket; after `stop`/shutdown
   reap, it is gone.
3. Shell: on `start`, a stale pidfile naming a live process whose command line is the helper
   entry ⇒ that process is TERMed (KILL backstop) before the new spawn; a pidfile naming a
   dead or non-matching pid ⇒ ignored and removed, nothing killed.
4. Existing sidecar contract tests and helper tests stay green.

**Out of scope**: packaging the helper into the app bundle; any change to routes, nonce, or
token flow; Baileys reconnect tuning; the (harmless) duplicate-log cosmetics beyond the fix.

## Plan

Approach (interview 2026-08-18): **both layers** — the helper exits when its parent dies
(prevents future orphans even with no relaunch), and the shell reaps any stale helper before
spawning (cleans up orphans left by older builds, which lack the watch). Immediate relief
already applied: orphan pid 60490 TERMed live; supervised helper kept the session.

### 1. Helper — parent-watch (`apps/whatsapp-sidecar`) — tests first

- `src/__tests__/parent-watch.test.ts`: fires `onOrphaned` exactly once when the observed
  ppid differs from the initial one; never fires while stable; timer does not hold the
  process open (unref'd — asserted structurally, not by exiting the test runner).
- `src/parent-watch.ts`: `watchParent({ getPpid, intervalMs, onOrphaned }): () => void`
  (returns stop). Captures the initial ppid on the first call; polls (default ~2s); a changed
  ppid means the spawning shell died and the helper was reparented (pid 1 / subreaper).
  `getPpid` injected so tests never fork anything.
- `src/cli.ts` `main()`: after `startSidecar` resolves, start the watch with
  `onOrphaned = shutdown` — the SAME function SIGTERM uses, so the final thread-cache flush
  (ADR-0037 §1) runs and the socket file is removed.

### 2. Shell — pidfile reap (`apps/desktop/src-tauri/src/sidecar.rs`) — tests first

- Pidfile lives beside the socket: `pidfile_path(snug_dir)` → `~/Snug/whatsapp-sidecar.pid`
  (same single-owner style as `socket_path`).
- Pure verdict fn + unit tests (no processes involved):
  `stale_helper_verdict(pidfile_contents, live_command_line, helper_entry) → Kill(pid) | Ignore`
  — Kill ONLY when the pidfile parses AND the live process's command line names the helper
  entry (guards pid-reuse: never kill an unrelated process that inherited the number).
  Tests: garbage pidfile ⇒ Ignore; dead pid (no command line) ⇒ Ignore; live pid with
  non-matching command ⇒ Ignore; live pid running the helper entry ⇒ Kill.
- `reap_stale_helper(&dir)`: read pidfile → look up the pid's command via
  `ps -o command= -p <pid>` (macOS/unix) → apply the verdict → on Kill, SIGTERM with the
  bounded wait + KILL backstop (reuse `reap_child`'s shape) → remove the pidfile either way.
  Called in `start_helper` after the preflights, before the socket unlink/spawn.
- Bookkeeping: write the pidfile right after the spawn survival check passes; remove it in
  `reap_child` alongside the socket file.

### 3. Build, test, verify

- `pnpm --filter whatsapp-sidecar test` and `build` + `install:helper` (refresh
  `~/Snug/helpers/whatsapp-sidecar`); `cargo test` in `apps/desktop/src-tauri`;
  desktop vitest suites (sidecar contract test must stay green — routes untouched).
- Manual: launch app → `kill -9` the shell → helper exits within the watch interval
  (criterion 1); plant a decoy pidfile naming a live non-helper pid → relaunch → decoy NOT
  killed, pidfile cleared (criterion 3); normal relaunch after crash with an old-build
  helper still running → reaped before spawn, no `conflict/replaced` in logs.

Cross-package impact: none — two leaf apps; no `packages/*`, no protocol change ⇒ no
spec-sync. No new ADR: this closes a lifecycle hole in ADR-0037's shutdown decision; record
a one-paragraph addendum note in the ADR-0037 file at close-out (append-only section).

## Decisions & surprises

- 2026-08-18: diagnosed from live `ps`: orphan helper (ppid 1) + supervised helper, same
  auth dir ⇒ WA "replaced" conflict loop. The credential/store layer is innocent (again —
  same shape as the ADR-0037 rival-writer wedge, different lifecycle hole).

## Session journal (append-only, newest last)

### 2026-08-18 23:2x — jeetu/claude — session
- Done: diagnosis (two helpers, one orphaned), code read (`sidecar.rs`, helper `cli.ts`/`server.ts`/`index.ts`), task file drafted.
- State: interview done (both layers; Low tier; orphan TERMed live — spam stopped, supervised
  helper 50057 holds the session). Plan written; branch created. Awaiting plan approval.
- Next step: on approval — Gate 3, tests first (parent-watch, then Rust verdict fns).
- Open questions: none.

### 2026-08-19 00:4x — jeetu/claude — session
- Done: **implemented, both layers, tests first.**
  - Helper: `src/parent-watch.ts` + 6 tests (written first, watched fail). Wired into
    `cli.ts` `main()` with `onOrphaned = shutdown` — the SAME handler SIGTERM uses, so the
    ADR-0037 §1 final flush still runs; exported from `index.ts`.
  - Shell: `pidfile_path`, `StaleHelper`, `stale_helper_verdict` (pure), `command_line_of`
    (`ps -o command=`; `None` on non-unix ⇒ the verdict refuses to kill), `reap_stale_helper`
    in `sidecar.rs`. `start_helper` reaps BEFORE the spawn and writes the pidfile only after
    the survival check; `reap_child` removes the pidfile alongside the socket. 8 new cargo
    tests written first.
- Verified:
  - Suites: cargo 97 pass / 1 ignored (the manual `SNUG_TEST_DIR` hook), whatsapp-sidecar
    152 pass (incl. `tsc`), desktop vitest 129 pass — `sidecarContract.test.ts` still green
    (no route touched). Clippy clean for this change (the 2 lib warnings pre-exist in
    `exportfile.rs` / `userfile.rs`).
  - Manual AC1: real helper spawned under a stand-in shell, shell `kill -9`'d ⇒ helper
    exited on its own ~1 s after reparenting and removed its socket.
  - Manual AC3 both directions: a live look-alike (command line naming the helper entry)
    was reaped (`Terminated: 15`) with pidfile + socket cleared; a live bystander named by
    a planted pidfile SURVIVED, and the stale claim was cleared anyway.
  - Helper rebuilt and reinstalled to `~/Snug/helpers/whatsapp-sidecar` — per lessons
    2026-08-18 the installed copy is a second deploy target and a running process a third,
    so the fix is not live in pid 50057 until it respawns.
- Docs: ADR-0037 addendum (2026-08-19), `lessons.md` entry (an exit hook covers only the
  exits that run it; verify the target before killing by pid), `code-map.md` row 54 extended.
- State: implementation complete and green on `fix/TASK-20260818-sidecar-orphan-reap`.
- Next step: owner review → PR. The new helper takes effect on the next desktop restart;
  pid 50057 still has the old code loaded.
- Open questions: none. Windows leaves `command_line_of` answering `None` (so it never
  kills) — consistent with ADR-0021 D8 leaving the platform open.

### 2026-08-19 01:0x — jeetu/claude — close-session (Gate 6)
- Done: PR #73 opened and squash-merged to `main` (`a8bd416`), branch deleted; task file
  moved to `done/` with its INDEX line; `next-steps.md` gained a dated 🔴 owner-action entry
  for the CI billing stop.
- **CI was NOT green and was not expected to be**: all three legs failed in ~2 s with zero
  steps executed. The annotation reads "The job was not started because recent account
  payments have failed or your spending limit needs to be increased" — a billing stop, not a
  test failure, and every recent `main` run (incl. already-merged PRs #67–#72) fails
  identically. Merged on local evidence per the owner's explicit instruction, matching how
  the two preceding tasks were closed. The gate's absence is now tracked in next-steps
  rather than only inside done-index prose, because it is on its third consecutive merge.
- State: shipped. `main` carries the fix; the working tree is clean.
- Next step: **restart the desktop client** — pid 50057 still runs the pre-fix helper, since
  a live process keeps the code it loaded at spawn. After that, the conflict loop cannot
  recur from either direction.
- Open questions: none.
