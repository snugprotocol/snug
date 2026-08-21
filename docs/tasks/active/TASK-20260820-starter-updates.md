# TASK-20260820-starter-updates: Starter app versioning & in-place updates

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: **high** — touches the two-fact declaration vouch in `starterDeclaration.ts` (connection-trust surface, C1-adjacent) and `packages/db` version/delete semantics. Per PROCESS auto-escalation, High: plan gets a fresh-context AI review before implementation + negative tests + journal self-sign-off.
- **Branch**: `feat/TASK-20260820-starter-updates`
- **Packages touched**: `apps/playground` (primary), `packages/db`, `examples/` (all 13 starters). **`packages/protocol` NOT touched** (no schema change — per-app starter version rides a namespaced `snug_settings` key, ADR-0036 D2 precedent).
- **Spec impact**: none (no protocol schema change)
- **Related**: next-steps.md items at :20/:35/:47/:66/:71 (this task closes :35/:66/:71 and part of :20); lessons.md 2026-08-19 "fixed on disk vs fixed for the user"; ADR-0018 (contract copy-forward), ADR-0035 (docs seeding), ADR-0036 D2 (settings-key precedent), ADR-0016/0017 (connection trust ladder); **new ADR-0045 drafted in this branch**.

## Spec (what & why)

Installed starters are frozen copies: install copies `examples/<folder>/app.html` into the user's snug file and the run path reads that snapshot forever, so shipped fixes never reach installed copies (`docs/architecture.md:301` states this as current fact; lessons.md 2026-08-19 documents the owner hitting it). This task gives every starter a version + cumulative release notes, surfaces "update available" on the hub tile and in the installed app's header, and adds a one-click update act that lands the new starter bytes as a **new version of the user's copy** via the existing versioning system — retaining all app data, credentials, connections, chat, and docs (all keyed by `app_id`, never by version).

Owner decisions (interview 2026-08-20):
1. **Update button lives in the app header only.** The hub tile shows an "update · vN" badge (replacing "installed") but stays read-only — the hub-never-writes doctrine (`HubView.tsx:161`) stands.
2. **Edited copies get one confirm dialog** ("you've customized this app; your edits stay in version history"); unedited copies update in one click.
3. **Version data**: integer versions + cumulative changelog in a new per-starter `examples/<folder>/starter.json`, loaded by a new glob module (the `starterApps.ts` glob is test-pinned to app-html only).
4. **Full factory refresh**: an update lands new HTML + the starter's new runtime contract; changed connection requirements flow through the existing declared-only refresh (never touches an approved/revoked row); new docs pages seed absent-only. Credentials, app data, chat, approved connections untouched.

**Acceptance criteria** (each becomes at least one test):
1. Every starter folder ships a valid `starter.json` (integer `version ≥ 1`; cumulative `changelog` whose newest entry matches `version`); the examples validator enforces this for all folders.
2. **Detection**: with the bundled version ahead of the installed one, the hub tile shows an "update · vN" badge (own CSS class, not `.tile-installed-badge`) instead of "installed"; when versions match, the tile shows "installed" exactly as today.
3. Legacy installs (no stored starter version): bytes of the newest pinned version matching the bundle ⇒ no update offered; differing ⇒ update offered. No false "update" badge for a fresh install.
4. **Header**: an installed starter's run header shows the installed starter version (e.g. "v2") and a "release notes" link; the link opens a formatted release-notes sheet rendering the changelog (sections + items, newest first, installed version marked). Non-starter apps show neither.
5. **Update act (unedited copy)**: clicking "update" in the header lands the new bundle HTML via `saveAppVersion` as a **pinned** version with note `starter update to vN`, writes the starter's new runtime contract onto that version, re-runs the declared-only connection refresh and absent-only docs seed, records the starter version, and reloads the running app (contentEpoch bump). One click, no dialog.
6. **Update act (edited copy)**: current HTML ≠ newest pinned HTML ⇒ the update button opens a confirm dialog first; confirming applies the same act; cancelling changes nothing.
7. **Retention**: after an update, app data tables, `auth:<appId>:*` secrets, connection rows (including `approved` status), chat threads, and user-written docs are byte-for-byte untouched; the user's pre-update version remains in `listAppVersions` and is revertable.
8. **Vouch survives update**: after a legitimate update, `resolveDeclaredIntent` still returns the declaration (no `html_mismatch`). Negative twins: a file with only `current_version` matching the bundle (foreign pinned rows) and a file with only a pinned version matching (foreign current) are both still refused.
9. **`resetToFactory` restores the newest pinned factory** (the updated starter), not v1; behavior is unchanged for apps with a single pinned version.
10. **`deleteApp` sweeps the `starterVersion:<appId>` settings key** (mutation-checked: key written, app deleted, key gone).
11. Release-notes authoring rule is written down: updating any starter's `app.html` requires bumping `starter.json` version + adding a changelog entry (enforced by AC1's validator; documented in `examples/README.md`).

**Out of scope**:
- Auto-update / background update (offered-only, per next-steps.md:71).
- Refreshing an **approved** connection requirement (the declared-only lock of `installStarterConnections` stands; a changed requirement on an approved slot stays as-is until the user re-reviews — recorded as accepted limitation in ADR-0045).
- Rendering the `html_mismatch` state (next-steps.md:47 stays open).
- Semver, downgrade paths, upstream version history for starter code (bundle replaces bytes; only notes accumulate).
- Desktop-specific packaging; server; sidecar.

## Plan

### Design decisions (→ ADR-0045, drafted in this branch)

- **D1 — factory = pinned, plural.** The update act writes the new bundle as a `pinned` version. The two-fact vouch generalizes fact 1 from "v1 matches the bundle" to "the **newest pinned** version matches the bundle" (fact 2, running version matches, unchanged). Forgery still requires controlling both the pinned row and `current_version` — same strength, and the documented v1-alone / current-alone holes stay closed. `resetToFactory` moves from MIN(pinned) to MAX(pinned) so "factory" means the starter you are on, not the day you installed.
- **D2 — installed starter version is a `snug_settings` row** `starterVersion:<appId>` (integer), written by install and update, swept by `deleteApp` (equality delete). No schema bump. Absent key ⇒ derived: newest-pinned bytes == bundle ⇒ current bundled version, else 1 (pre-versioning install).
- **D3 — `starter.json` per folder** `{ version, changelog: [{ version, date, title?, sections: [{ title, items[] }] }] }`, newest first; loaded by a new module with its own glob.
- **D4 — hub stays read-only**; the update act joins `installThisStarter` in RunView as the second write act of the same class (host-trusted, awaited, never throws into navigation).

### Files to touch (order)

**Phase 0 — data + validator (AC1, AC11)**
1. `examples/<each of 13 folders>/starter.json` — v1 + initial changelog entry.
2. `examples/validate.test.mjs` — require starter.json per folder, shape + newest-entry-matches-version.
3. `examples/README.md` — the authoring rule (bump + notes on every app.html change).

**Phase 1 — packages/db (AC5 mechanics, AC9, AC10)** — tests first in `packages/db/src/userdb/__tests__/` (or existing test file locations)
4. `packages/db/src/userdb/app-settings-keys.ts` — `STARTER_VERSION_SETTING_PREFIX`, `starterVersionSettingKey(appId)`, `appIdFromStarterVersionSettingKey(key)` (mirror the appModel doctrine comment).
5. `packages/db/src/userdb/userdb.ts` —
   - `saveAppVersion(appId, html, note?, contractSourceVersion?, pinned = false)` (interface :530 + impl :2082; passes `pinned` through to `insertVersion`).
   - `resetToFactory` :2310 — `MIN` → `MAX(version) WHERE pinned = 1`.
   - `deleteApp` cascade (~:2220) — equality-delete the starterVersion key beside the appModel delete.
6. Rebuild `packages/db` before any dependent suite (lessons.md 2026-08-15: dependents resolve `dist/`).

**Phase 2 — playground starter modules (AC2, AC3, AC5, AC6, AC7, AC8)** — tests first
7. New `apps/playground/src/starter/starterMeta.ts` — own `import.meta.glob('../../../../examples/*/starter.json')`, tolerant parse, `starterMetaFor(folder)`. (A second glob in `starterApps.ts` fails the AC9 pin in `starterShelf.test.tsx` — hence a new module.)
8. New `apps/playground/src/starter/starterUpdate.ts` —
   - `starterUpdateStatus(db, appId)` → `{ installedVersion, latestVersion, updateAvailable, edited }` implementing D2's derivation; `edited` = normalize(current) ≠ normalize(newest pinned) (reuse `normalize` from starterDeclaration).
   - `applyStarterUpdate(db, appId)` → load bundle html + meta; `saveAppVersion(..., note: 'starter update to vN', contractSourceVersion: undefined→see below, pinned: true)`; write the starter's runtime contract for the new version (explicit `putRuntimeContract`, overriding copy-forward — ADR-0018 D2 is about user edits, an update ships factory contract); `installStarterConnections`; `installStarterDocs`; `setSetting(starterVersionKey, N)`. Never throws into the UI path (install-act posture).
9. `apps/playground/src/starter/starterDeclaration.ts` :213-221 — fact 1 reads the newest pinned version (via `listAppVersions`) instead of hardcoded v1; rewrite the doctrine comment to name the update act; keep the warn.

**Phase 3 — UI (AC2, AC4, AC5, AC6)** — component tests first
10. New `apps/playground/src/run/ReleaseNotesSheet.tsx` — Tesla-style formatted sheet (title, version headers, sectioned bullet lists, installed-version marker); CSS in `theme/app.css`.
11. `apps/playground/src/run/RunView.tsx` — for installed starters: version chip + "release notes" link in the identity block (~:710); "update to vN" button in the header cluster (~:749 region) when `updateAvailable`; confirm dialog when `edited`; on success bump `setContentEpoch` (:233 pattern) and refresh local state. Explicit `aria-label`s (RunHeaderActions comment rules; lessons.md 2026-08-18 label-as-API).
12. `apps/playground/src/views/HubView.tsx` — compute update status for installed tiles (async, meta + bytes via db); new `.tile-update-badge` class ("update · vN") replacing the installed badge when available — **own class**, `dedup.spec.ts` uses `.tile-installed-badge` as a strict single-element selector; sub-blurb copy branch.

**Phase 4 — docs & close**
13. `docs/architecture.md:301` — installed starters now have a named update path; §two-fact-vouch text (:88-98) updated for pinned-plural.
14. `docs/code-map.md` — starter rows updated (new modules, new test files).
15. `docs/next-steps.md` — prune :35/:66/:71; annotate :20.
16. ADR-0045 finalized; spec-changelog untouched (no protocol change).

### Test plan (tests FIRST, per TDD.md)

| AC | Test | Location |
|----|------|----------|
| 1, 11 | validator red on missing/ill-formed/stale starter.json; green on all 13 | `examples/validate.test.mjs` |
| 5, 9 | `saveAppVersion` pinned param: pinned row survives retention prune; `resetToFactory` with two pinned versions restores the **newest** (fails on current MIN impl — verified-red before fix); single-pin behavior unchanged | `packages/db` |
| 10 | starterVersion key swept on deleteApp; key module shape tests | `packages/db` |
| 2, 3 | detection matrix: fresh install ⇒ no update; bundle ahead + unedited ⇒ available, not edited; bundle ahead + edited ⇒ available + edited; legacy no-key bytes-match ⇒ none; legacy no-key bytes-differ ⇒ available | playground `starterUpdate` tests |
| 5, 7 | `applyStarterUpdate`: new pinned version + note; starter contract on new version (not copy-forward); app data table rows, `auth:` secret, approved connection row, chat, user docs all unchanged (assert values, not absence of error); old version still listed + revertable; settings key written | playground |
| 8 | vouch: post-update file passes; current-only forgery refused; pinned-only forgery refused (negative twins, High-tier requirement) | playground `starterDeclaration` tests |
| 4 | header renders version + release-notes link for installed starter only; sheet renders sections; non-starter app renders neither | playground component tests |
| 6 | edited ⇒ dialog; cancel ⇒ no version written (assert version count, lessons.md count-the-writes); confirm ⇒ act runs | playground component tests |
| 2 | hub badge class + copy; `.tile-installed-badge` still unique when no update pending | playground + `e2e/dedup.spec.ts` unchanged-green |

Gate-5 extras (lessons-mandated): root `turbo run test --force`; **one real-browser walk** — temporarily bump one starter (`trivia-night`, slated for removal anyway) to v2 with real notes in a throwaway commit on this branch, walk install-on-old → badge → header → release notes → update → reload → data-retained in the running playground, screenshots into the journal, then drop the throwaway bump. This is the "run the product" verification no suite performs (lessons.md 2026-08-20/2026-08-19).

Mutation checks: revert the vouch change and watch AC8's update-pass test red; delete the deleteApp sweep line and watch AC10 red; revert MIN→MAX and watch AC9 red.

### Cross-package impact

`packages/db` → `apps/playground` (rebuild before dependent runs). `packages/protocol`, `auth`, `runner`, `sdk` untouched. Dependent suites to run: db, playground, plus root force run.

### High-tier gate

After owner plan approval: dispatch a **fresh-context AI plan review** (committed, coherent tree — lessons.md 2026-08-20) before any implementation code; record findings + dispositions here.

## Decisions & surprises

- `resetToFactory` uses `MIN(pinned)` today — with update-pins that would restore stale bytes (the exact broken exit lessons.md 2026-08-19 names). D1 flips to MAX.
- `contentEpoch` (:180/:233) already exists as the post-write reload lever (VersionsPanel uses it) — the update act reuses it; no new reload machinery.
- The vouch comment (:195-212) explicitly documents why both facts exist; D1 preserves the two-fact shape rather than dropping one (lessons.md 2026-08-19: propose into stated doctrine).

## Session journal (append-only, newest last)

### 2026-08-20 — Claude (with owner) — session
- Done: explored starter/versioning surfaces (full report in plan refs); interviewed owner (4 decisions recorded in Spec); drafted plan + ADR-0045; branch created.
- State: awaiting owner plan approval (Gate 2 stop). No implementation code written.
- Next step: on approval → fresh-context plan review (High tier), then Phase 0 tests.
- Open questions: none blocking.
