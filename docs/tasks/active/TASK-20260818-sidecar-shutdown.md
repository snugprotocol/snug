# TASK-20260818-sidecar-shutdown: stop the WhatsApp helper when the shell exits

- **Status**: in-review (fix implemented and green; owner re-pair + restart walk owed)
- **Owner**: jeetu
- **Risk tier**: **medium** — `apps/desktop` shell lifecycle only. No protocol change, no
  credential-path change, no C1/C2 surface touched (the helper's spawn/admission/transport
  are all unchanged; this adds the missing REAP).
- **Branch**: `fix/TASK-20260818-sidecar-shutdown`
- **Packages touched**: `desktop` (Rust `sidecar.rs`/`lib.rs` + the source-pin test)
- **Spec impact**: none
- **Related**: ADR-0032 (the helper is a spawn-supervised child), ADR-0034,
  `docs/solutions/2026-08-17-eight-seam-defects-in-one-feature.md` (rule 3: every injected
  dependency is an untested wire; rule 4: ask what survives)

## Spec (what & why)

Owner-reported 2026-08-18: *"the app loses connection across hub restarts — if I stop my hub
client desktop app and rerun it asks me to relink the connection for WhatsApp."*

**The credential layer was innocent.** Verified on the owner's machine: the `snug_connections`
row is `approved` with the symbolic host frozen in its ceiling, the minted `sidecar_token`
secret is present and byte-identical to the helper's own `access-token.json`, and the
`_connection` KV reads `{"status":"connected","linkVerifiedAt":…}`. All of it survives a
restart exactly as designed.

**What was actually broken: nothing ever stopped the helper.** `sidecar_ctl("stop")` was
implemented, tested and reachable — and had **no caller anywhere in the codebase**, with no
exit hook of any kind. So quitting the shell orphaned the child. The next launch spawned a
RIVAL against the same Baileys auth store, and two processes writing one session directory is
how a link ends up half-registered (`registered:false` with a saved `me`) — the wedge that
reads to a user as "it lost my connection and wants me to link again". Confirmed live: two
helpers 17 minutes apart on the owner's machine, then a third after a later restart.

This is the eight-seams shape again — a spawn path fully tested, its reap path absent — and
it is why the previous session's wedge kept coming back after being cleared.

**Acceptance criteria** (each becomes at least one test):
1. `shutdown` kills the running child, reaps it, and removes the socket file. (cargo)
2. `shutdown` is a no-op when nothing is running, and safe to call twice — Tauri can deliver
   Exit after a window-destroy path already ran. (cargo)
3. A poisoned mutex still yields the handle: a panic elsewhere must never leak the process.
   (covered by construction in `shutdown`; asserted by the no-op/twice tests running against
   a healthy mutex)
4. The exit hook EXISTS and calls it — pinned at the source level, because no unit test can
   drive Tauri's real `RunEvent` and a hook nobody calls is precisely the defect class here.
   (desktop `sidecarContract.test.ts`)

**Out of scope**: the half-linked session already on disk (only re-pairing clears it — the
app now says so honestly, TASK-20260817); Windows (the named-pipe twin stays behind ADR-0021
D8); any change to spawn, admission, or the credential path.

## Plan

1. `sidecar::shutdown(&SidecarState)` — infallible and idempotent by construction (it runs
   where there is nobody to report to), recovering a poisoned mutex rather than panicking.
2. Call it from `RunEvent::Exit` in `lib.rs` — the one event that fires however the app quits
   (window close, Cmd-Q, dock quit).
3. Source-pin the wiring in the desktop suite alongside the existing handler-list pins.

## Decisions & surprises

- **`RunEvent::Exit`, not the `CloseRequested` handler.** The close handshake already exists
  for the DB flush, but it fires only on a window-close request and is deliberately
  prevented-then-deadlined; hanging process teardown off it would tie helper lifetime to one
  window's close path. Exit is the honest "the app is going away" signal.
- **`linkVerifiedAt` is written and never read** (`connectionWizard.ts:1146` writes it;
  nothing consumes it). Not a bug for this task — the wizard does not gate on it — but it is a
  dead seat that looks load-bearing, and a future reader will assume it guards something.
  Recorded in next-steps rather than removed blind.

## Session journal (append-only, newest last)

### 2026-08-18 — claude (fable) — session (report → diagnosis → fix)
- Done: read the DB, the helper's own on-disk token, and the live helper's `/chats` reply
  BEFORE theorising (the read-first rule from yesterday's lessons — it settled the credential
  question in one step and pointed at process lifetime instead). Found `sidecar_ctl('stop')`
  with zero callers; added `shutdown` + the `RunEvent::Exit` hook + a source pin. Killed the
  two orphans on the owner's machine and removed the stale socket; their running app spawned
  one fresh helper, which is the auto-start behaving correctly.
- Verified: cargo **84** (81 → 84), desktop vitest **129**, root `turbo run test --force`
  **23/23**.
- State: branch `fix/TASK-20260818-sidecar-shutdown`, tree clean, all green. Not merged.
- Next step: owner re-pairs the linked device (the on-disk session is still wedged from
  before this fix), then restarts the app twice to confirm the connection survives.
- Open questions: none blocking. `linkVerifiedAt`'s dead-read is recorded in next-steps.
