# TASK-20260820-snug-file-and-encryption: `.snug` as the canonical file + passphrase encryption at rest

- **Status**: planned — **awaiting owner plan approval (Gate 2)**
- **Owner**: Jeetu
- **Risk tier**: **HIGH** (auto-escalated three ways: `packages/protocol` schema surface (`USERDB_FILE` is spec-normative); `packages/db` is widely depended on; the change rewrites an *accepted* threat-model residual — R-3 / adversary A6)
- **Branch**: `feat/TASK-20260820-snug-file-and-encryption` (off `main` @ `d25a282`)
- **Packages touched**: `packages/protocol`, `packages/db`, `packages/knowledge` (regen), `apps/playground`, `apps/desktop` (+ `src-tauri`), docs, whitepaper. **NOT** `apps/server` (owner decision D6), **NOT** `packages/auth`, **NOT** `packages/runner`.
- **Spec impact**: **YES** — spec v0.2-userdb amendment staged (→ [SPEC_SYNC.md](../../engineering/SPEC_SYNC.md)). No push to `snugprotocol/spec` without an explicit owner ask in-session.
- **Related**: ADR-0007 (one portable file), ADR-0009 (sync origins), ADR-0014 (credentials local-first — **explicitly deferred this exact feature**), ADR-0021 D6 (`.snug` association already registered), ADR-0027 (distill), threat-model R-3 / A5 / A6

---

## Spec (what & why)

Two changes to the one artifact that *is* the product — the user's portable file.

**Part 1 — `.snug` becomes the canonical name.** The repo is already half-way there and currently **inconsistent**: ADR-0021 D6 registered `.snug` with the OS at `rank: Owner`, desktop exports `snug-user.snug`, but web exports `snug-user.sqlite` and the web import picker's `accept` list omits `.snug` entirely. This finishes the decision ADR-0021 started and fixes a live bug on the way.

**Part 2 — opt-in passphrase encryption at rest, and on every copy that leaves the device.** Today `~/Snug/user.snug` is plaintext: threat-model R-3 states the OS user account is the perimeter and adversary **A6 (a local process running as the same user) is "explicitly not defended."** ADR-0014 considered client-side passphrase encryption and **deferred rather than rejected** it, naming the cost precisely: *"adds a forgotten-passphrase data-loss mode and does not change custody."* This task takes that deferral off the shelf and pays the named cost down with a **Recovery Key** (a second independent unlock path), which is what makes shipping it defensible.

### Owner decisions taken at Gate 1 (2026-08-20)

| # | Decision | Chosen | Rejected, and why it matters |
|---|---|---|---|
| **D1** | Crypto route | **Snug envelope: `SNUGENC1` magic + AES-256-GCM, key from PBKDF2-SHA256** | *SQLCipher engine swap* — sql.js has no cipher build; replacing the engine under db+playground+desktop is a months-long migration. *Secrets-only encryption* — leaves app data (the bulk of R-3's exposure) readable. |
| **D2** | Lost-passphrase net | **Recovery Key** (high-entropy, generated at setup, shown once, also unlocks) + typed acknowledgement | *Passphrase-only* — this is exactly the data-loss mode ADR-0014 refused to ship. *OS-keychain convenience unlock* — hands the perimeter back to the OS account, undoing the A6 defence being bought. |
| **D3** | Rollout | **Opt-in, offered prominently at first run**, changeable in Settings; existing plaintext files keep opening untouched | *Mandatory* — makes passphrase loss a universal failure mode and permanently ends sqlite-tooling openability. *Settings-only* — nobody finds it; the threat-model gain stays theoretical. |
| **D4** | Scope | **One branch, both parts** | Split was offered; owner chose together because both touch the SAME seam (persistence magic + file naming) and splitting means renaming twice. |
| **D5** | Encryption boundary | **At rest AND exports AND personal-origin sync** | *At-rest only* — the Dropbox copy is the most likely one to "fall into the wrong hands", which is the stated purpose. |
| **D6** | Hub sync while encrypted | **Hub origin keeps receiving secrets-stripped PLAINTEXT; server untouched** | *Teach the hub `SNUGENC1`* — a real `apps/server` + spec-contract change for the LEAST sensitive copy (ADR-0014 already guarantees hub copies are secrets-free). *Disable hub sync* — removes a working feature. |
| **D7** | Spec | **Both spec'd**: ADR-0042 (`.snug`) + ADR-0043 (container), plus staged amendment text in `spec-v0.2-userdb.md` | Container format is genuinely interop-normative: another hub MUST be able to detect an encrypted file and prompt, not treat it as corrupt. |
| **D8** | Review depth | **Full High-tier walk**: fresh-context plan review before code, multi-angle diff review before merge | Precedent: the last High-tier task's plan review caught 2 blockers and its diff review caught 3 confirmed defects. |

### Acceptance criteria (each becomes at least one test)

**Part 1 — `.snug`**
1. `USERDB_FILE === 'user.snug'`, and opening a hub whose backend holds a legacy `user.sqlite` **and no `user.snug`** loads the legacy file's real contents (never a fresh empty DB), then persists forward to `user.snug`.
2. Once `user.snug` exists, a stale `user.sqlite` sitting beside it is **ignored** — the newer canonical file always wins; the legacy file is left on disk untouched (never deleted).
3. Web and desktop export the **same** suggested filename `snug-user.snug`; the platform branch at `SettingsView.tsx:360` is gone.
4. The web import picker accepts `.snug` **and** `.sqlite` (regression: a desktop-exported `.snug` is selectable in the web import dialog — broken today).
5. Per-app export produces `<name>.snug`; the run-header control's accessible name is the new label and the two `e2e/starters.spec.ts` locators are updated in the same commit (per `docs/lessons.md:7` — that lane does not run in CI, so a stale locator fails silently).
6. Dropbox sync reads legacy `/snug/user.sqlite` when `/snug/user.snug` is absent, then adopts the new path — no user's remote copy is orphaned.
7. `apps/server`'s own stores (`artifacts.sqlite`, `threads.sqlite`, `users.sqlite`, `userdbs.sqlite`) are **unchanged** — they are server infrastructure, not user data.

**Part 2 — encryption**
8. A `SNUGENC1` container round-trips: encrypt(plaintext, passphrase) → decrypt → **byte-identical** plaintext.
9. `looksComplete()` accepts `SNUGENC1` bytes, so an encrypted file is **never** quarantined as corruption by the OPFS A/B recovery, the desktop file backend, or `openUserDb`.
10. A wrong passphrase yields an explicit `state: 'locked'` with a retry affordance — **never** a fresh empty DB and **never** a quarantine (F6 doctrine: the user DB never fails open).
11. The Recovery Key unlocks a file whose passphrase is wrong/forgotten, and is verifiably independent (each wraps the same file key in its own slot).
12. Changing the passphrase does **not** require re-encrypting the whole database (key-wrapping design), and does **not** invalidate the Recovery Key.
13. Enabling encryption on an existing plaintext file converts it in place, atomically — a crash mid-conversion leaves a readable file (either old or new, never a torn hybrid).
14. Disabling encryption converts back to plaintext, gated on a fresh passphrase entry.
15. An encrypted export is `SNUGENC1`; a hub-origin sync push is still **plaintext, secrets-stripped** (D6), and the sync content-hash gate still short-circuits an unchanged file (hash the plaintext, encrypt after).
16. Importing a `SNUGENC1` file the user cannot unlock fails with a clear, non-destructive error — it must not clobber the current file.
17. Negative/C-constraint tests: the passphrase and derived keys are **never** written into `snug_secrets`, never leave the host page, never enter an LLM payload, and never cross the runner bridge.

**Out of scope**
- Swapping the SQLite engine (no SQLCipher/wa-sqlite migration).
- The hub server learning `SNUGENC1` (D6) — `apps/server` is untouched.
- OS-keychain / biometric convenience unlock (D2 rejected it for now; revisit post-1.0).
- Per-app DB file encryption for direct `@snugprotocol/db` embedders — only the ONE user file is encrypted (per-app DBs are materialized rows inside it, so they are covered transitively).
- Windows/Linux desktop (ADR-0021 D8: macOS-only through 1.0).
- Pushing to `snugprotocol/spec` (needs an explicit owner ask).

---

## Plan

### Why this is buildable (research settled at Gate 1)

- **The engine is `sql.js` 1.14.1** (vanilla SQLite WASM) in `packages/db`, `apps/playground`, `apps/desktop` — **one shared code path**. There is no SQLCipher and no `PRAGMA key`; SQLite's own SEE is a paid closed-source extension. "Use SQLite's own encryption" is therefore **not available**, which is what forces D1.
- **Persistence is already whole-file.** `db.export()` → `Uint8Array` on a 250 ms debounce; `new SQL.Database(bytes)` on open. There is exactly **one** chokepoint — `PersistenceBackend.load/save` — and it is already dependency-injected. An encrypting decorator over it covers OPFS, IndexedDB and the Tauri file backend at once, with **zero changes to `userdb.ts`'s open path**.
- **There is already a precedent for a non-SQLite magic container at that exact seam**: `SYNC_SIDECAR_MAGIC = 'SNUGSYNC1\n'`, which `looksComplete()` accepts beside the SQLite magic. `SNUGENC1` is a third magic in the same list — an established pattern, not a new one.
- **WebCrypto (PBKDF2 + AES-GCM) is available on every shipping surface.** The desktop `subtle-fallback` only implements SHA-256/HMAC and would *not* cover `deriveBits`/AES-GCM — but `docs/code-map.md:56` records it is **"measured NOT needed on macOS, tauri:// is secure"**, and ADR-0021 D8 ships macOS-only through 1.0. **No Rust crypto crate is required.** (Guarded by AC below: a boot-time capability probe must refuse to *enable* encryption where `crypto.subtle.deriveBits` is missing, rather than silently degrading.)
- **One file to encrypt.** Per-app databases are materialized from `app_<token>__*` rows inside the user file, so encrypting the outer file covers every app's data, every chat, and every secret.

### The container format (draft — normative text goes to spec v0.2)

```
offset  size  field
0       9     magic          "SNUGENC1\n"
9       1     version        0x01
10      2     kdf id         0x0001 = PBKDF2-HMAC-SHA256
12      4     iterations     u32 BE (600_000 baseline, OWASP)
16      16    salt           per-file, random
32      2     slot count     u16 BE (2: passphrase, recovery key)
--- per slot (repeated) ---
        1     slot kind      0x01 passphrase | 0x02 recovery-key
        12    wrap IV
        variable  wrapped file key (AES-256-GCM over the 32-byte file key)
--- payload ---
        12    payload IV
        variable  AES-256-GCM(sqlite bytes)   [tag appended]
```

**Key-wrapping, not direct encryption** — this is what makes AC12 and AC11 possible: one random 32-byte *file key* encrypts the database; the passphrase and the Recovery Key each independently wrap that file key in their own slot. Changing the passphrase rewraps one slot (cheap) instead of re-encrypting 64 MiB, and the Recovery Key survives it.

### Files to touch, in order

**Stage 0 — tests first (Gate 3, per `docs/engineering/TDD.md`)**
Every AC above gets a failing test before the corresponding implementation. Highest-value negatives, written first: legacy-fallback opens real data (AC1); wrong passphrase never opens fresh (AC10); encrypted bytes never quarantined (AC9); key material never in `snug_secrets` (AC17).

**Stage 1 — protocol (HIGH; spec surface)**
| File | Change |
|---|---|
| `packages/protocol/src/userdb-schema.ts` | `USERDB_FILE` → `'user.snug'`; add `USERDB_LEGACY_FILE = 'user.sqlite'`; add `USERDB_FILE_EXTENSION`/`USERDB_LEGACY_EXTENSION` (the research found **six independent spellings of the suffix** across TS+Rust+JSON with no shared constant — this fixes that); add the `SNUGENC1` container constants (magic, version, KDF id, iteration baseline, slot kinds). |
| `packages/protocol/src/index.ts` | Re-export the new constants. |
| `packages/protocol/src/__tests__/userdb-schema.test.ts` | Update the `'user.sqlite'` pin; pin the new constants. |

**Stage 2 — db: naming + legacy fallback (HIGH)**
| File | Change |
|---|---|
| `packages/db/src/userdb/userdb.ts` (`openUserDb`, ~:1120) | The **only** production `USERDB_FILE` site. Add: try canonical → if absent, try legacy → adopt-forward on next persist. Legacy file is never deleted (AC2). |
| `packages/db/src/namespace.ts` (:20,:23) | Per-app store suffix → the shared constant. |
| `packages/db/src/sync/dropbox.ts` (:20) | `DROPBOX_DEFAULT_PATH` → `/snug/user.snug` + legacy-read fallback (AC6). **Migration hazard: without the fallback every existing user's remote copy is silently orphaned.** |
| `packages/db/src/sync/loop.ts` (:79) | Flows through the constant; verify sidecar naming (`<file>.sync.json`) still satisfies Rust `valid_name`. |

**Stage 3 — db: the crypto container (HIGH, new code)**
| File | Change |
|---|---|
| `packages/db/src/crypto/container.ts` *(new)* | Pure, DI-friendly: `encryptContainer`, `decryptContainer`, `isEncryptedContainer`, `deriveKey`, `wrapFileKey`, `rewrapSlot`, `generateRecoveryKey`. No DOM, no storage — testable in isolation. |
| `packages/db/src/crypto/encrypted-backend.ts` *(new)* | `createEncryptedBackend(inner, unlocked)` — the decorator over `PersistenceBackend`. **This is the whole at-rest story.** |
| `packages/db/src/persistence.ts` (:12–29) | Register `SNUGENC1` in `looksComplete` (AC9) — the single most important line in the task; without it every encrypted file is quarantined on first open. |
| `packages/db/src/file-backend.ts` (:42) | Error text follows the widened completeness rule. |
| `packages/db/src/userdb/userdb.ts` (`hasSqliteMagic` :718, open :1131, import :2904) | Detect `SNUGENC1` and return a new `status: 'locked'` — distinct from `'corrupt'`, so AC10 holds. |
| `packages/db/src/index.ts` | Barrel exports. |

**Stage 4 — export/sync boundary (D5 + D6)**
| File | Change |
|---|---|
| `apps/playground/src/state/sync.ts` (:215 `exportUserFile`, :224 `importUserFile`) | Encrypt after the secrets-strip+VACUUM (never before — the strip needs plaintext); detect+decrypt on import. |
| `packages/db/src/sync/loop.ts` (:126,:162) | **Order is load-bearing**: `exportPayload()` → `sha256Hex(plaintext)` for the change gate → *then* encrypt for personal origins only. Hub origins keep pushing plaintext (D6), so `apps/server` and `/userdb`'s magic check are untouched. |
| `apps/playground/src/state/userdb.ts` (:136 `restoreUserDbFromBytes`) | Format-detect before writing raw bytes; it hardcodes `backend.save(USERDB_FILE, bytes)` (:148) so it must write the **canonical** name, not the legacy one. |
| `apps/playground/src/state/userdb.ts` (:118 `userDbNeedsRestore`) | **Verified by hand**: this is a hardcoded three-state list (`corrupt`/`unsupported`/`load-failed`). `'locked'` must NOT join it — a locked file is not a torn file, and offering "restore from backup" as the answer to a forgotten passphrase would talk a user into overwriting good data. The unlock screen owns that state instead. |

**Stage 5 — Hub UI/UX (the flagship flow)**
| File | Change |
|---|---|
| `apps/playground/src/state/userdb.ts` (:36–49) | Add `{ state: 'locked'; … }` to `UserDbStatus`. The store is already a discriminated union with three terminal states each rendering full-screen UI, and `getUserDb()` **deliberately never resolves** while not ready — which is exactly the gating semantic an unlock screen needs, already load-bearing. |
| `apps/playground/src/vault/UnlockScreen.tsx` *(new)* | **Relaunch unlock.** One idea per screen, matching `DesktopWelcome`'s established voice. Passphrase field, "unlock", a quiet "use Recovery Key instead", honest failure copy that never implies data loss. |
| `apps/playground/src/vault/ProtectSetupFlow.tsx` *(new)* | **First-run setup**, three steps: (1) *Protect this file?* — plain-language what it does and what it costs, with a real "not now"; (2) *Choose a passphrase* + confirm, live strength feedback, no arbitrary composition rules; (3) *Your Recovery Key* — shown once, copy/download/print, with a **typed acknowledgement** ("I saved it"), stated flatly: no reset, no backdoor, nobody can recover it. |
| `apps/playground/src/vault/RecoveryKeyView.tsx` *(new)* | Grouped, unambiguous alphabet (no `0/O`, `1/l/I`), copy + download + print. |
| `apps/playground/src/App.tsx` (:64) | Branch `'locked'` → `UnlockScreen`, before the shell renders. |
| `apps/playground/src/views/SettingsView.tsx` (:360 export name, :459 accept list, DataCard) | Fix the platform branch (AC3) and the accept list (AC4); add turn-on / turn-off / change-passphrase / regenerate-Recovery-Key; the origin copy must state plainly that a hub origin receives a plaintext secrets-free copy (D6 — ADR-0014's wizard-copy duty). |
| `apps/playground/src/run/RunHeaderActions.tsx` (:158,:159) + `RunView.tsx` (:539) | Label + filename. |
| `apps/playground/src/desktop/firstRun.ts` | **Ordering constraint**: the existing first-run latch is persisted *inside the user file*, so it cannot gate unlocking that file. Protect-setup runs **after** the DB is open on a genuinely new file; unlock runs **before**. Must not re-welcome a veteran file. |

**Stage 6 — desktop shell**
| File | Change |
|---|---|
| `apps/desktop/src-tauri/src/exportfile.rs` (:19) | Default save name → `snug-user.snug` (already correct — verify only). |
| `apps/desktop/src-tauri/src/openfile.rs` (:21) | Keeps admitting both `snug` and `sqlite` (security gate; widening is not needed, narrowing would break legacy opens). |
| `apps/desktop/src-tauri/tauri.conf.json` | Already `ext: ["snug"]`, `rank: Owner` — verify only. Consider `mimeType` once encrypted files are no longer `application/x-sqlite3`. |
| `apps/playground/src/platform/openFile.ts` (:31) | Extension gate already `/\.(snug|sqlite)$/i` — verify; add encrypted-format detection to the magic check at :16. |
| `apps/desktop/src/main.tsx` | Capability probe: refuse to *enable* encryption where `crypto.subtle.deriveBits` is unavailable (fail loudly, never silently degrade). |

**Stage 7 — docs, ADRs, spec (Gate 6 work, done in-branch)**
- **ADR-0042** — `.snug` as the canonical user-file name (supersedes the naming half of ADR-0021 D6; updates its status line per ADR-0027).
- **ADR-0043** — passphrase encryption at rest + the `SNUGENC1` container. **Must explicitly amend ADR-0014's "Alternatives considered" entry** — that ADR deferred this feature by name, so its status line changes in this same branch.
- `docs/threat-model.md` — rewrite **R-3** (no longer "the OS user account is the perimeter" when protection is on) and **A6** (no longer "explicitly not defended"); state the honest new boundary: encryption defends a file **at rest**, not a live compromised host page (R-1 is unchanged), and not a device where the passphrase is being typed. Update the assets table (:69).
- `docs/security/threat-model-delta-desktop-shell.md` (:32) — same correction.
- `docs/spec-drafts/spec-v0.2-userdb.md` — normative container text + the conformance rule (a hub MUST detect `SNUGENC1` and prompt, not treat it as corrupt) + `.snug` naming.
- `docs/spec-changelog.md` — entry. **No push to `snugprotocol/spec`** without an explicit owner ask.
- `docs/architecture.md`, `docs/code-map.md`, `docs/glossary.md`, `README.md`, `SECURITY.md`, `docs/whitepaper/src/paper.html` (:642,:730) + figures `fig1`/`fig5`/`fig6` (SVG text), `examples/*/README.md`, and `packages/knowledge/prompts/knowledge-base/app-authoring/40-persistence-and-db.md` → **regenerate** `packages/knowledge/src/generated/content.ts` (generated file — never hand-edit).
- **Claim discipline (ADR-0014 §5)**: the public claim may strengthen only to *"your file can be encrypted with a passphrase only you hold"* — never to "zero-knowledge" or "end-to-end encrypted". `docs/threat-model.md:425` ("no cryptographic custody claim") needs a careful, scoped correction rather than deletion.

### Enforcement gates this plan must satisfy (verified by reading `scripts/`, 2026-08-20)

The repo mechanically enforces the doc work in Stage 7 — these are not optional prose edits, and each is wired into `pnpm test` at root.

| Gate | What it enforces | What this task must do |
|---|---|---|
| **TM3** (`check-threat-model.mjs`) | Every `docs/security/threat-model-delta-*.md` is pinned in a delta ledger **by content hash**; an edited delta fails until the model re-consolidates | Editing `threat-model-delta-desktop-shell.md:32` (the "plaintext file" claim) **breaks the ledger hash by design** → `docs/threat-model.md` must re-consolidate and the ledger row be re-pinned in the same change |
| **TM4** | Every invariant row names an enforcement point **and** a test, as repo paths **that must exist** | Any new encryption invariant added to the table must ship with a real test path — no promise without named enforcement |
| **TM5** | The residuals section carries the named accepted residuals | R-3 is rewritten, not deleted; the forgotten-passphrase residual is **added** as a named residual |
| **TM6** | The macOS-only shipped surface is stated | Unchanged — but the capability probe (Stage 6) must not imply Windows support |
| **AC1/AC2** (`check-whitepaper.mjs`) | The whitepaper **PDF** exists, is non-trivial, and carries exact embedded metadata | Editing `paper.html` (:642,:730) + figures means **rebuilding the PDF** via `docs/whitepaper/build.mjs`, not just editing source |
| **AC6** | No unbuilt claim, no anti-positioning language | The encryption claim must not outrun what ships (ADR-0014 §5 claim discipline) |
| `check-gate-local`, `check-sandbox-guard` | Local merge gate (ADR-0041) + C2 sandbox guard | Run `pnpm gate:local` at root; CI remains billing-blocked, so merges proceed on local evidence recorded in the journal |

### Test plan (tests FIRST)

| Layer | Suite | Covers |
|---|---|---|
| `packages/protocol` | `userdb-schema.test.ts` | AC1 constants, container constants |
| `packages/db` | `crypto/__tests__/container.test.ts` *(new)* | AC8, AC11, AC12 + **tamper tests**: flipped ciphertext byte, truncated payload, wrong slot → GCM auth failure, never a silent partial read |
| `packages/db` | `crypto/__tests__/encrypted-backend.test.ts` *(new)* | AC9, AC13, AC14, crash-mid-conversion |
| `packages/db` | `userdb.test.ts`, `file-backend.test.ts`, `persistence.test.ts` | AC1, AC2, AC9, AC10 |
| `packages/db` | `sync/__tests__/providers.test.ts`, `loop.test.ts` | AC6, AC15 (hash gate still short-circuits) |
| `apps/playground` | `__tests__/vaultSetup.test.tsx`, `vaultUnlock.test.tsx` *(new)* | Stage-5 flows, AC10, AC11 |
| `apps/playground` | `exportDbPlatform.test.ts`, `syncState.test.ts`, `runHeaderIcons.test.tsx`, `openFile.test.tsx`, `userdbLoadFailure.test.tsx` | AC3, AC4, AC5, AC16 |
| `apps/playground` | `e2e/starters.spec.ts` (:72,:101) | AC5 — **locator updated in the same commit** (`docs/lessons.md:7`: this lane does not run in CI, so a stale locator fails silently) |
| `apps/desktop` | `bundleTargets.test.ts`, cargo `openfile.rs`/`userfile.rs` | Stage 6 |
| **Negative (C1/C2)** | new | AC17 — key material never in `snug_secrets`, never in an LLM payload, never across the runner bridge |

Run per Gate 5: every touched package **plus dependents** (`protocol` → `db` → `sdk`/`runner`/`playground`/`desktop`), and `pnpm gate:local` at root.

### Risks, ranked

1. **Silent data loss via the rename** (highest). `USERDB_FILE` and `DROPBOX_DEFAULT_PATH` both move; without legacy-read fallback a user opens a fresh empty DB beside their real data and may then overwrite the remote copy. Mitigated by AC1/AC2/AC6 as **first** tests written.
2. **Forgotten passphrase = unrecoverable data.** Mitigated by the Recovery Key (D2), the typed acknowledgement, and opt-in rollout (D3) — but the residual is real and must be stated plainly in ADR-0043 and the threat model, not designed away.
3. **Encrypted bytes read as corruption** → the quarantine path destroys confidence. Single most important line: `looksComplete` (AC9).
4. **Crash mid-conversion** (plaintext ⇄ encrypted). Mitigated by reusing the existing atomic write (Rust temp+fsync+rename) and the OPFS A/B slot commit — never a bespoke second atomicity mechanism (`file-backend.ts:14` doctrine: one atomicity contract).
5. **Sync hash-gate regression** — encrypting before hashing makes every 30 s tick look "changed" and pushes constantly. Order pinned in Stage 4 and tested (AC15).
6. **`e2e/starters.spec.ts` label coupling** in a lane CI does not run — `docs/lessons.md:7` documents this exact trap.
7. **CI is billing-blocked** (standing condition) — merges proceed on local `pnpm gate:local` evidence, recorded in the journal.

### Gate sequence from here

1. **Gate 2 approval — owner. ← WE ARE HERE. No implementation code until this is approved.**
2. Fresh-context AI plan review (D8, required for High tier).
3. Gate 3 tests → Gate 4 implement → Gate 5 verify + multi-angle diff review (D8) → Gate 6 close.

---

## Decisions & surprises

### Self-found gap in this plan (2026-08-20, before implementation) — the second-device pull

Verifying Stage 4 against `packages/db/src/sync/loop.ts` exposed a hole in my own plan that the ACs did not cover.

**The bug.** `pullMerge` (`loop.ts:148`) calls `userDb.importUserDb(remote.bytes)`. Under D5 those bytes are now ciphertext. A **second device** pulling them must decrypt before it can read anything — but if the file key were a per-device random stored inside the local file, the pulling device has no way to obtain the key for the *remote* container. ADR-0009 explicitly promises the file is "restorable on a new device after login", so this is a first-class flow, not an edge case. Left unfixed it would brick cross-device sync the moment a user turns encryption on — the exact "don't lock the user out" failure the owner named.

**The fix, folded into the design.** The container is **self-opening**: every `SNUGENC1` artifact carries its own header (salt, KDF params, slot table) and its slots wrap that artifact's own file key. So *anything* that can be unlocked with the passphrase or the Recovery Key can be opened by any device, with **no shared state outside the file**. Concretely:

- **Never** persist the file key, the passphrase, or any derived key into `snug_secrets` (already AC17) — the key must be re-derivable from passphrase + header alone, or cross-device breaks by construction.
- `pullMerge` gains a decrypt step keyed on `isEncryptedContainer(remote.bytes)`; a container the device cannot unlock becomes an explicit **`locked-remote` divergence event** (surfaced, never auto-resolved, per ADR-0009's "pull is a merge, never a swap"), and **must not** clobber local state.
- **Re-encrypting on each push does NOT re-key**: pushes reuse the same file key with a fresh payload nonce, so a second device that unlocked yesterday's copy still unlocks today's.
- **Nonce discipline (see E in the crypto review angle)**: a fresh random 12-byte payload IV per encryption, never derived from content, and the file key is rotated only on an explicit user action (turn-off/turn-on), never silently.

**New acceptance criteria (added to Part 2):**
18. A container encrypted on device A is unlockable on device B **with the passphrase alone** — no shared state beyond the file itself.
19. A pulled container the device cannot unlock surfaces a `locked-remote` divergence and leaves local state **untouched** (never clobbered, never quarantined).
20. Repeated pushes of an unchanged database do not re-key: a container captured after push N still unlocks after push N+1 with the same passphrase.

### Measured: crypto cost (2026-08-20, Node 22 WebCrypto — same engine the webview uses)

Settles two of the three open questions with numbers rather than guesses.

| Operation | Cost |
|---|---|
| PBKDF2-SHA256 100k iters | 27 ms |
| PBKDF2-SHA256 310k iters | 84 ms |
| **PBKDF2-SHA256 600k iters** | **175 ms** |
| PBKDF2-SHA256 1M iters | 306 ms |
| AES-256-GCM encrypt 1 MiB | 2 ms |
| AES-256-GCM encrypt 8 MiB | 6 ms |
| AES-256-GCM encrypt 32 MiB | 23 ms |
| **AES-256-GCM encrypt 64 MiB (the `MAX_USERDB_BYTES` cap)** | **88 ms** |
| AES-256-GCM decrypt 64 MiB | 88 ms |

**Conclusions.**
1. **PBKDF2 iterations: pin 600_000.** 175 ms is a deliberate, once-per-launch cost the user experiences as instant, and it is the OWASP baseline. Store the count in the header so it can be raised later without breaking old files (re-derive-and-rewrap on unlock when the stored count is below the current floor).
2. **Whole-file AES-GCM on every save is NOT a performance problem** — 6 ms on a realistic file, 88 ms at the 64 MiB hard cap, against a 250 ms debounce. **No worker and no chunking are needed**; the plan's Stage 3 stays a simple decorator. (AES-NI hardware acceleration is why. Re-measure in the actual WKWebView during Gate 5 rather than assuming parity.)

### Answering the owner's two framing questions directly

**"Does moving to `.snug` make sense?"** — Yes, and it is less of a change than it looks: ADR-0021 D6 already decided it (*"same sqlite byte format; a filename convention, not a new format"*), the OS association already claims `.snug` at `rank: Owner`, and desktop already exports it. What exists today is an unfinished migration, not a green field.

**"Will it break anything? Will the db functions work seamlessly?"** — The **DB functions are entirely unaffected**: sql.js neither knows nor cares about a filename, the SQLite magic header is unchanged, and all validation sites sniff **content**, not extension. The break risk is **not** in the database layer — it is in **four filename lookups** (`USERDB_FILE`, `DROPBOX_DEFAULT_PATH`, and two extension gates), where renaming without a legacy fallback means an existing user silently gets an empty database. That is why AC1/AC2/AC6 are the first tests written.

**"Can we leverage SQLite's offered encryption or password-to-open?"** — **No.** The engine is `sql.js`, the vanilla SQLite WASM build: no SQLCipher, no `PRAGMA key`. SQLite's own encryption (SEE) is a paid closed-source extension. Hence D1's envelope approach.

**"Does this add value to the protocol / should it be spec'd?"** — **Yes, and it is genuinely protocol surface**, not just an app feature. Under ADR-0007 the user-file layout is normative *because portability requires every hub to agree on it*. An encrypted container is the strongest case of that rule: a hub that cannot detect `SNUGENC1` will treat a user's protected file as **corrupt and quarantine it**. So the spec must carry the container format, the KDF parameters, and the conformance rule that a hub MUST detect and prompt. D7 stages that text; the push to `snugprotocol/spec` waits for an explicit owner ask.

### Pre-existing defects this task fixes
- `SettingsView.tsx:459` — the web import picker's `accept` omits `.snug`, so a desktop-exported file is **greyed out** in the web import dialog today.
- `SettingsView.tsx:360` — web/desktop export different extensions for the same artifact.
- Six independent spellings of the file suffix across TS + Rust + JSON with **no shared constant**.
- `tauri.conf.json` registers only `snug` with the OS while `openfile.rs` admits both `snug` and `sqlite` — a documented asymmetry.

### Surprises worth keeping
- `SYNC_SIDECAR_MAGIC` is an exact precedent for a Snug-owned magic container living where a SQLite file would — the encrypted container is the same pattern, not a novel one.
- `getUserDb()` **never resolving** while the DB isn't ready is already the gating primitive an unlock screen needs; no new mechanism required.
- The desktop first-run latch is stored **inside the user file** ("the file is the identity"), which creates a real ordering constraint: it cannot gate unlocking the file that holds it.
- The `subtle-fallback` would not cover PBKDF2/AES-GCM — but it is measured unnecessary on macOS, and macOS is the only platform shipping through 1.0. Worth a guard, not a redesign.

## Session journal (append-only, newest last)

### 2026-08-20 — Jeetu — session (Gates 1–2)
- Done: Gate 1 research (two parallel code surveys: rename inventory + engine/persistence/crypto feasibility); owner interview, 8 decisions recorded (D1–D8); branch created off `main` @ `d25a282`; Gate 2 plan written.
- State: **planned — awaiting owner approval. No implementation code written.**
- Next step: on approval → fresh-context plan review (D8), then Gate 3 (tests first), starting with the legacy-fallback and never-fails-open negatives.
- Open questions: **PBKDF2 iterations SETTLED at 600k by measurement (175 ms) and whole-file AES-GCM measured harmless (88 ms at the 64 MiB cap) — no worker needed**; Recovery Key alphabet/length (proposal: 24 chars, Crockford-style, no `0/O`/`1/l/I`); whether `tauri.conf.json`'s `mimeType` should stop claiming `application/x-sqlite3` once a `.snug` may be an encrypted container.
