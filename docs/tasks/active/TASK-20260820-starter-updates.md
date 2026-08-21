# TASK-20260820-starter-updates: Starter app versioning & in-place updates

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: **high** — touches the two-fact declaration vouch in `starterDeclaration.ts` (connection-trust surface, C1-adjacent) and `packages/db` version/delete semantics. Per PROCESS auto-escalation, High: plan gets a fresh-context AI review before implementation + negative tests + journal self-sign-off.
- **Branch**: `feat/TASK-20260820-starter-updates`
- **Packages touched**: `apps/playground` (primary), `packages/db`, `examples/` (all 13 starters). **`packages/protocol` NOT touched** (no schema change — per-app starter version rides a namespaced `snug_settings` key, ADR-0036 D2 precedent).
- **Spec impact**: none (no protocol schema change)
- **Related**: next-steps.md installed-starter-update items (at :35/:71 as of branch time — this task closes those two and part of :20; the :66 security block stays open); lessons.md 2026-08-19 "fixed on disk vs fixed for the user"; ADR-0018 (contract copy-forward), ADR-0035 (docs seeding), ADR-0036 D2 (settings-key precedent), ADR-0016/0017 (connection trust ladder); **new ADR-0045 drafted in this branch**.

## Spec (what & why)

Installed starters are frozen copies: install copies `examples/<folder>/app.html` into the user's snug file and the run path reads that snapshot forever, so shipped fixes never reach installed copies (`docs/architecture.md:301` states this as current fact; lessons.md 2026-08-19 documents the owner hitting it). This task gives every starter a version + cumulative release notes, surfaces "update available" on the hub tile and in the installed app's header, and adds a one-click update act that lands the new starter bytes as a **new version of the user's copy** via the existing versioning system — retaining all app data, credentials, connections, chat, and docs (all keyed by `app_id`, never by version).

Owner decisions (interview 2026-08-20):
1. **Update button lives in the app header only.** The hub tile shows an "update · vN" badge (replacing "installed") but stays read-only — the hub-never-writes doctrine (`HubView.tsx:161`) stands.
2. **Edited copies get one confirm dialog** ("you've customized this app; your edits stay in version history"); unedited copies update in one click.
3. **Version data**: integer versions + cumulative changelog in a new per-starter `examples/<folder>/starter.json`, loaded by a new glob module (the `starterApps.ts` glob is test-pinned to app-html only).
4. **Full factory refresh**: an update lands new HTML + the starter's new runtime contract; changed connection requirements flow through the existing declared-only refresh (never touches an approved/revoked row); new docs pages seed absent-only. Credentials, app data, chat, approved connections untouched.

**Acceptance criteria** (each becomes at least one test):
1. Every starter folder ships a valid `starter.json` (integer `version ≥ 1`; cumulative `changelog` whose newest entry matches `version`; **`appHash` = normalized sha-256 of `app.html`**); the examples validator recomputes the hash and enforces all of this for all folders — so an `app.html` edit without a version bump + changelog entry goes red (plan-review finding 1).
2. **Detection**: with the bundled version ahead of the installed one, the hub tile shows an "update · vN" badge (own CSS class, not `.tile-installed-badge`) instead of "installed"; when versions match, the tile shows "installed" exactly as today.
3. Legacy installs (no stored starter version): bytes of the newest pinned version matching the bundle ⇒ no update offered; differing ⇒ update offered. No false "update" badge for a fresh install.
4. **Header**: an installed starter's run header shows the installed starter version (e.g. "v2") and a "release notes" link; the link opens a formatted release-notes sheet rendering the changelog (sections + items, newest first, installed version marked). Non-starter apps show neither.
5. **Update act (unedited copy)**: clicking "update" in the header lands the new bundle HTML via `saveAppVersion` as a **pinned** version with note `starter update to vN`, **with the starter's new runtime contract written in the same synchronous db call** (no durable window where new HTML runs under the old contract — plan-review finding 3), re-runs the declared-only connection refresh and absent-only docs seed, records the starter version, and reloads the running app (contentEpoch bump). One click, no dialog. The act is **idempotent**: re-invoking when the copy already matches the bundle writes nothing (no pinned-row accumulation).
5b. **Install records the starter version**: `installThisStarter` writes `starterVersion:<appId>` at install time (plan-review finding 4), so fresh installs never rely on derivation.
6. **Update act (edited copy)**: current HTML ≠ newest pinned HTML ⇒ the update button opens a confirm dialog first; confirming applies the same act; cancelling changes nothing.
7. **Retention**: after an update, app data tables, `auth:<appId>:*` secrets, connection rows (including `approved` status), chat threads, and user-written docs are byte-for-byte untouched; the user's pre-update version remains in `listAppVersions` and is revertable.
8. **Vouch survives update**: after a legitimate update, `resolveDeclaredIntent` still returns the declaration (no `html_mismatch`). Negative twins: a file with only `current_version` matching the bundle (foreign pinned rows), a file with only a pinned version matching (foreign current), **and a file with zero pinned rows + matching current** (plan-review finding 6) are all refused.
8b. **VersionsPanel with plural pinned rows**: the "pinned forever" banner and factory selection follow the **newest** pinned version (pinned by test); every pinned row keeps the `factory` tag (each is a factory snapshot — install-day and each starter update); header comment updated (plan-review finding 5).
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
   - `saveAppVersion(appId, html, note?, contractSourceVersion?, opts?: { pinned?: boolean; contractJson?: string })` (interface :530 + impl :2082) — `pinned` passes through to `insertVersion`; `contractJson` **overrides** the copy-forward source so the update act's contract lands in the same synchronous call (stored in the exact shape `putRuntimeContract` writes). All existing call sites (≤4 args) unaffected.
   - `resetToFactory` :2310 — `MIN` → `MAX(version) WHERE pinned = 1`.
   - `deleteApp` cascade (~:2220) — equality-delete the starterVersion key beside the appModel delete.
6. Rebuild `packages/db` before any dependent suite (lessons.md 2026-08-15: dependents resolve `dist/`).

**Phase 2 — playground starter modules (AC2, AC3, AC5, AC6, AC7, AC8)** — tests first
7. New `apps/playground/src/starter/starterMeta.ts` — own `import.meta.glob('../../../../examples/*/starter.json')`, tolerant parse, `starterMetaFor(folder)`. (A second glob in `starterApps.ts` fails the AC9 pin in `starterShelf.test.tsx` — hence a new module.)
8. New `apps/playground/src/starter/starterUpdate.ts` —
   - `starterUpdateStatus(db, appId)` → `{ installedVersion, latestVersion, updateAvailable, edited }` implementing D2's derivation; `edited` = normalize(current) ≠ normalize(newest pinned) (reuse `normalize` from starterDeclaration).
   - `applyStarterUpdate(db, appId)` → idempotence guard (already at bundle bytes + key current ⇒ no-op); load bundle html + meta + parsed contract; ONE `saveAppVersion(appId, html, 'starter update to vN', undefined, { pinned: true, contractJson })` (atomic w.r.t. persistence — synchronous db body); then `installStarterConnections` (vouch passes at this point: newest pinned = current = new bundle); `installStarterDocs`; `setSetting(starterVersionKey, N)` last so a partial failure keeps the update offered. Never throws into the UI path (install-act posture). `normalize` exported from starterDeclaration for byte comparisons.
9. `apps/playground/src/starter/starterDeclaration.ts` :213-221 — fact 1 reads the newest pinned version (via `listAppVersions`) instead of hardcoded v1; rewrite the doctrine comment to name the update act; keep the warn.

**Phase 3 — UI (AC2, AC4, AC5, AC6)** — component tests first
10. New `apps/playground/src/run/ReleaseNotesSheet.tsx` — Tesla-style formatted sheet (title, version headers, sectioned bullet lists, installed-version marker); CSS in `theme/app.css`.
11. `apps/playground/src/run/RunView.tsx` — for installed starters: version chip + "release notes" link in the identity block (~:710); "update to vN" button in the header cluster (~:749 region) when `updateAvailable`; confirm dialog when `edited`; on success bump `setContentEpoch` (:233 pattern) and refresh local state. **`installThisStarter` (:412) additionally writes `starterVersion:<appId>`** (AC5b). Explicit `aria-label`s (RunHeaderActions comment rules; lessons.md 2026-08-18 label-as-API).
11b. `apps/playground/src/run/VersionsPanel.tsx` — newest-pinned banner/factory selection made deliberate + tested; header comment `:4-5` updated for plural pinned (AC8b).
12. `apps/playground/src/views/HubView.tsx` — compute update status for installed tiles (async, meta + bytes via db); new `.tile-update-badge` class ("update · vN") replacing the installed badge when available — **own class**, `dedup.spec.ts` uses `.tile-installed-badge` as a strict single-element selector; sub-blurb copy branch.

**Phase 4 — docs & close**
13. `docs/architecture.md:301` — installed starters now have a named update path; §two-fact-vouch text (:88-98) updated for pinned-plural.
14. `docs/code-map.md` — starter rows updated (new modules, new test files).
15. `docs/next-steps.md` — prune the two installed-starter-update items (at :35 and :71 as of branch time — **verify by content, not line number**; plan-review finding 2: :66 is the HELD AL-10/AL-11 security block and the "re-vouch on user edits" sub-item — neither is closed by this task, do NOT prune); annotate the :20 sample-mode note.
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

### 2026-08-20 — Claude — High-tier fresh-context plan review (pre-implementation)
- Verdict: no blockers; 6 should-fixes, **all accepted** and folded into the plan above: (1) `appHash` in starter.json so the validator enforces the bump rule; (2) next-steps :66 is the held AL-10/11 security block — corrected the prune list; (3) contract lands in the same synchronous `saveAppVersion` call via `opts.contractJson` + idempotence guard; (4) install act writes the starterVersion key (AC5b); (5) VersionsPanel is a real pinned-consumer — AC8b added; (6) zero-pinned-rows negative twin added to AC8.
- Vouch generalization verified sound by the reviewer against forged-import attack shapes (pinned-N forgery admits only genuine bundle bytes; MIN→MAX improves the forged-v1 reset corner). Full grep confirmed VersionsPanel is the only unplanned pinned consumer.
- Notes adopted: glob pin actually lives in `examples/validate.test.mjs:448` (add a sibling pin for starterMeta's glob); export `normalize`; hub badge defaults to "installed" while async status resolves; header chip after a manual revert intentionally keeps showing the keyed starter version (copy decision, documented here).
- Consciously rejected findings: none — all six accepted.
- Next step: Phase 0 (validator tests red → starter.json ×13).

### 2026-08-21 — Claude — implementation (Phases 0–4) + Gate 5
- Done, tests-first throughout:
  - **Phase 0** (`e095e3f`): starter.json ×13 (v1, initial notes) + the ADR-0045 validator block (shape + `appHash` byte-binding) + the authoring rule in examples/README. RED first (13 fails), then green; hash guard mutation-checked (html edit without release → red naming the paste-in fix).
  - **Phase 1** (`ef3075f`): `saveAppVersion` opts `{pinned, contract}` (contract validated BEFORE any write; nothing stranded on refusal), `resetToFactory` MIN→MAX pinned, `deleteApp` sweeps `starterVersion:<appId>`, key helpers. db 401/401. Mutations: MAX-revert reds 2 tests; sweep-removal reds 1. (Process slip logged in Decisions below.)
  - **Phase 2** (`c2a8f55`): `starterMeta.ts` (own glob + validator sibling pin; parse-and-drop; seam-OFF real-glob probe per lessons 2026-08-08), `starterUpdate.ts` (detection matrix; idempotent act with key self-heal; contract landed atomically; declared-only/absent-only refreshes), vouch fact 1 → newest pinned (empty set refuses; doctrine comments rewritten; `normalizeStarterHtml` exported). 17+4 new tests; existing vouch suites (31+16) untouched-green. Mutation: v1-revert reds exactly the update-pass + zero-pin twins.
  - **Phase 3** (`584508e`): `StarterUpdateControls` (chip + release-notes sheet + one-click/confirmed update; cancel asserted as version COUNT), `ReleaseNotesSheet`, RunView mount + install-time key write (AC5b), VersionsPanel plural-pin comment + test, HubView `update · vN` badge (own class; "installed" default while async status resolves), CSS. Playground 1381/1381.
  - **Phase 4** (`853f9c4`): architecture.md (newest-pin vouch; rebuild claim; corrected the stale "reported in Settings" sentence), code-map row, next-steps pruned by CONTENT (the two installed-starter items; :20 caveat softened; the AL-10/11 block untouched per review finding 2), ADR index backfilled 0041–0045.
- **Gate 5 evidence**: root `turbo run test --force` — 23/23 tasks, `Cached: 0`, exit 0 (read from the process, not the summary). **Real-browser walk** (vite dev + agent-browser, screenshots in session scratchpad walk-01…09): installed trivia-night at v1 → header `v1` chip + Tesla-style notes sheet ("v1 — Initial release · INSTALLED") → throwaway bump to v2 (visible html marker + starter.json) → hub tile flipped to `UPDATE · V2` replacing "installed" → header showed `update to v2` → ONE click → frame reloaded live with the new bytes RUNNING (the probe marker on screen) → chip `v2`, update button gone → versions panel: v2 CURRENT+FACTORY ("starter update to v2") above v1 FACTORY with revert → notes sheet marks v2 installed → hub badge cleared, plain "installed" restored. Throwaway bump reverted; validator green after restore; tree clean.
- **High-tier self-sign-off**: the vouch change shipped with its negative twins (current-only, pinned-only, zero-pin) plus the untouched 47 pre-existing declaration/install-act tests; the fresh-context plan review's six findings are all folded in and none rejected; C1/C2 surfaces (runner, auth, credential paths) untouched by construction — the update act writes only version rows, declared-only connection rows, absent-only docs, and one settings key. Signed: the implementing agent, 2026-08-21.

## Decisions & surprises (implementation)

- **Process slip, logged for lessons**: during Phase 1 mutation-checking I restored a mutated file with `git checkout -- <file>` while the same file carried UNCOMMITTED implementation — wiping it (recovered by re-applying from context). The 2026-08-20 lesson ("restore from HEAD, not stash") assumes the tree is otherwise clean; the sharper rule: **mutation-check only files whose correct state is committed, or restore the mutation by inverse edit, never by checkout.**
- The component tests initially raced the update act by waiting on the FIRST db write (html) instead of the completion callback — same family as "element not found names the wrong element"; fixed by waiting on the outcome (`onUpdated`).
- A doc comment containing the literal glob pattern `examples/*/app.html` terminates the block comment at `*/` — esbuild parse error. Spell glob patterns in prose inside block comments.
