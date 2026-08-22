# TASK-20260822-wa-authstate-corruption: WhatsApp sidecar — heal corrupt auth-state key files, stop app-state resync loop

- **Status**: in-review (implementation + repair done; AC6 owner walk pending)
- **Owner**: Jeetu
- **Risk tier**: Medium (owner-confirmed 2026-08-22) — session-credential storage reliability in `apps/whatsapp-sidecar`; no protocol/runner/auth packages touched. Test-first per TDD.md.
- **Branch**: `fix/TASK-20260822-wa-authstate-corruption`
- **Packages touched**: `apps/whatsapp-sidecar`
- **Spec impact**: none
- **Related**: ADR-0032 (WhatsApp socket seam), ADR-0034 (surface v2)

## Spec (what & why)

The desktop app's terminal shows a repeating (~every 10 min) Baileys error loop:
`failed to find key "AAAAAK7c" to decode mutation` → retry with snapshot → `regular blocked on missing key from v0, parking after 2 attempts`.

**Diagnosed root cause (2026-08-22):** `/Users/jeetu/Snug/whatsapp-session/app-state-sync-key-AAAAAK7c.json` is corrupt on disk — trailing extra `"}` after valid JSON (mtime Aug 20 10:29). Baileys' `useMultiFileAuthState.readData` swallows the `JSON.parse` error and returns `null`, so the app-state sync treats the key as *missing*, parks the `regular` collection, and re-fails on every server-triggered resync. Consequence beyond log spam: chat-metadata app-state sync (archive/pin/mute/read) never applies.

The second logged item — `identity key changed or new contact, session will be re-established` — is benign level-30 Signal housekeeping, not a fault.

Underlying weakness: the sidecar uses stock `useMultiFileAuthState`, whose `writeFile` is not crash-atomic; an interrupted write corrupts a key file permanently and unrecoverably.

**Acceptance criteria** (owner-confirmed 2026-08-22; each becomes at least one test):
1. **Format compatibility both directions**: the sidecar's own auth state reads a store written by baileys' `useMultiFileAuthState`, and vice versa — an existing linked session resumes unchanged, no re-pair.
2. **Crash-atomic writes**: every auth-state write goes to a temp name and renames into place (0600, thread-cache pattern); no `*.tmp` residue after a write.
3. **Salvage on read**: a key file that is valid JSON followed by trailing garbage (the exact live corruption: `…}"}`) is parsed, returned to sync, and the healed bytes are rewritten atomically.
4. **Quarantine on unsalvageable**: an unparseable file is renamed aside (`*.corrupt*`, never deleted) and read as absent — sync parks that collection but nothing is destroyed and messages keep flowing. Corrupt `creds.json` likewise quarantines before falling back to fresh creds (stock baileys silently discards).
5. **Log level**: `makeWASocket` receives a `level:'warn'` logger — benign info-level chatter (`identity key changed…`, `resyncing regular…`) no longer reaches the desktop terminal; warn/error still do.
6. **Live repair**: after helper reinstall + respawn, the `AAAAAK7c` file is healed on next read and the 10-minute parking loop stops (verify: `synced regular to vN` appears / no new parking lines).
7. No regression: existing whatsapp-sidecar suite (router / session-reset / baileys-socket / store.persistence / thread-cache…) stays green.

**Out of scope** (owner-confirmed): upgrading baileys beyond 7.0.0-rc14; any richer log routing (files, levels config); surfacing sync-health in the desktop UI ("fail loudly" option declined — quarantine chosen); the benign identity-key re-establishment behavior itself (it is correct Signal housekeeping).

## Plan

**Design.** Replace stock `useMultiFileAuthState` with a sidecar-owned `createFileAuthState(folder)` in a new `src/auth-state.ts` — same on-disk format (`creds.json` + `<type>-<id>.json`, `BufferJSON` serialization, `fixFileName` `/`→`__` `:`→`-`, `app-state-sync-key` values revived through `proto.Message.AppStateSyncKeyData.fromObject`), but with the ADR-0037 thread-cache write rules: temp+rename atomic writes at 0600, salvage-then-quarantine reads. This is the ADR-0032 seam philosophy applied to auth storage: the library's storage helper is the moving part we now own; the library's socket stays behind the seam. Building blocks (`BufferJSON`, `initAuthCreds`, `proto`) are verified exports of the rc14 tarball (read, not remembered). Salvage = progressively trim trailing bytes (bounded, files are ≤ a few KB) until `JSON.parse` succeeds; heal file on success.

**Files to touch, in order (tests FIRST per TDD.md):**
1. `apps/whatsapp-sidecar/src/__tests__/auth-state.test.ts` (new) — AC1 (two-way compat against the real `useMultiFileAuthState` in node_modules), AC2 (no tmp residue; content parses), AC3 (exact live corruption shape salvaged + healed), AC4 (garbage quarantined, read-as-absent; corrupt creds quarantined), null-set deletes key file.
2. `apps/whatsapp-sidecar/src/auth-state.ts` (new) — implementation as above.
3. `apps/whatsapp-sidecar/src/__tests__/baileys-socket.test.ts` — extend: `makeWASocket` config carries a `level:'warn'` logger whose info/debug/trace are no-ops and warn/error forward (AC5); mocked-baileys harness already exists.
4. `apps/whatsapp-sidecar/src/baileys-socket.ts` — swap both `useMultiFileAuthState` call sites (`:354` connect, `:760` forget-reload) to `createFileAuthState`; add `logger` to the `makeWASocket` config (`:596`); promote the existing `MediaLogger` shape/silent logger into a shared minimal-logger helper with a `warn` variant.
5. `apps/whatsapp-sidecar/src/wa-socket.ts` — header note: verified-surface list gains `BufferJSON`/`initAuthCreds`/`proto`, drops `useMultiFileAuthState` from the required surface (kept only as a test oracle for format compat).
6. Docs: `docs/code-map.md` row update; `docs/lessons.md` candidate ("a library that swallows a parse error reports corruption as absence — the error message names the wrong fault"); task file journal.

**Cross-package impact:** none — `apps/whatsapp-sidecar` only; the seam (`WaSocket`) is unchanged, so router/server/playground/desktop are untouched. Spec impact: none.

**Deploy (lesson 2026-08-18 — three targets):** repo build → `pnpm --filter whatsapp-sidecar run install:helper` (installed artifact at `~/Snug/helpers/whatsapp-sidecar`) → respawn the live helper (desktop restart; stale-helper reap handles the old pid). Then AC6 live verification against the corrupt `AAAAAK7c` file. Backup `~/Snug/whatsapp-session/app-state-sync-key-AAAAAK7c.json` before the healing run (copy aside) purely as forensic insurance.

**Test plan:** `pnpm --filter whatsapp-sidecar test` (new + existing suites); AC6 is a live manual walk recorded in the journal.

## Decisions & surprises

- 2026-08-22: Key file EXISTS but is corrupt — the "missing key" wording in Baileys hides a parse failure (`readData` catches and returns null). Diagnosis, not assumption: file read and parse-checked directly.

## Session journal (append-only, newest last)

### 2026-08-22 — Jeetu/Claude — session
- Done: Diagnosed root cause (corrupt key JSON, non-atomic writes); task file created.
- State: awaiting interview answers, then plan + branch.
- Next step: interview → plan → approval.
- Open questions: risk tier; scope of durable fix vs one-time repair; log-noise policy.

### 2026-08-22 (later) — Jeetu/Claude — session
- Done: Plan approved. Tests-first: `auth-state.test.ts` (11 — two-way format compat with the real `useMultiFileAuthState` as oracle incl. a `/`+`:` key id, atomic 0600 writes with no tmp residue, the exact live corruption shape salvaged AND healed on disk, quarantine for key files / empty files / creds.json, null-set deletes) + 2 logger-floor tests in `baileys-socket.test.ts`. Implemented `src/auth-state.ts` (`createFileAuthState`: sync I/O, temp+rename, salvage-prefix healing, `.corrupt` quarantine) and swapped both call sites in `baileys-socket.ts`; `makeWASocket` now gets `warnFloorLogger` (level `warn`, child-preserving, warn/error → stderr with payload). Full sidecar suite green: **171/171**, build clean. Deploys: repo built ✓; helper reinstalled to `~/Snug/helpers/whatsapp-sidecar` (new `auth-state.js` confirmed present) ✓; live `AAAAAK7c` file hand-healed atomically (164→162 bytes, re-parse verified; backup at `app-state-sync-key-AAAAAK7c.json.pre-heal-backup`) ✓. Docs: code-map row, lessons.md entry (swallowed-parse-error ≙ corruption-as-absence).
- State: live helper process (pid 75094) still runs pre-task code — third deploy target.
- Next step: **owner walk (AC6)**: restart the desktop app (respawns helper on new code), watch terminal for `synced regular to vN` and absence of `parking after 2 attempts` over ≥2 resync cycles (~20 min). Then AI review → PR.
- Open questions: none.
