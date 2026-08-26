# TASK-20260826-helper-bundle-update-sheet: bundle the WhatsApp helper (size-gated) + fix the update sheet (clipping, stale "good to know")

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: **High** (auto-escalated: release config/gate + a new download-verify-extract path in the shell + a `packages/auth` text touch). Per PROCESS.md the plan gets a fresh-context AI review before implementation. The update-sheet half alone would be Low.
- **Branch**: `fix/TASK-20260826-helper-bundle-update-sheet`
- **Packages touched**: `apps/desktop` (`src-tauri/src/sidecar.rs` + new `helper_install.rs`, `Cargo.toml`, `src/sidecar.ts`, `platform-desktop.ts`, release gate), `apps/whatsapp-sidecar` (new `pack-helper.mjs`), `apps/playground` (`desktop/AppUpdateControls.tsx`, `desktop/desktop-releases.json`, `theme/app.css`, `platform/platform.ts`, `state/connectionWizard.ts`, `state/net.ts`, `run/RunView.tsx`, `connections/ConnectionWizardSheet.tsx`, `views/DownloadView.tsx`), `packages/auth` (`well-known-providers.ts` instructions text only), new `scripts/release-helper.mjs`, docs (ADR-0060, ADR-0047 amendment, threat-model delta, architecture, code-map, next-steps)
- **Spec impact**: none (protocol untouched)
- **Related**: **ADR-0060 (draft, this task)**, ADR-0047 §12 (helper NOT distributed by the update channel), ADR-0032 (sidecar contract), TASK-20260816-whatsapp-twin (packaging declared out of scope there), `docs/security/threat-model-delta-desktop-update-channel.md` (helper-skew residual), `docs/next-steps.md` (spawner version-stamp check)

## Spec (what & why)

Two owner-reported issues, one task. Interview (2026-08-26) reset Part 1's direction.

**Part 1 — on-demand helper distribution (ADR-0060 draft).** No bundling. Helpers become
separately released, pre-release-tagged GitHub artifacts (`helper-whatsapp-sidecar-v0.1.0`),
self-contained (own Node runtime, no sharp; ≈ 41 MB per arch), minisign-signed with the
updater key, version-pinned by the shell. When an app needing a `linked_device` connection is
installed (or pairing begins) and the helper is absent/outdated, the user is offered a
one-click download into `~/Snug/helpers/<name>/`; on success the shell spawns it immediately.
A developer install (`install:helper`, no `helper.json` stamp) always wins if present.
Measured facts: current tree 62 MB (26 MB optional sharp); minus sharp 5.6 MB gz; Node 22
arm64 35 MB gz; DMG 18 MB. `minisign-verify`, `tar`, `flate2` already in the Cargo tree.

**Part 2 — update sheet.** (a) The sheet from the header chip is clipped at the top. **Actual
root cause (found by screenshot repro, not the plan's guess):** the sheet is rendered inside
the header nav and `.shell-header` has `backdrop-filter`, which makes it the containing block
for `position: fixed` descendants — the overlay's `inset: 0` was the header's ~50 px box, the
card centred on it and clipped. Fix: `createPortal` to `document.body` (plus the CSS
hardening the plan proposed, which is correct but was not the cause). (b) The "macOS only through
1.0…" line is **v0.1.0's** "Good to know", rendered because the sheet shows the whole bundled
history beneath the new entry (`AppUpdateControls.tsx:107-116`). Owner decisions: show only
entries newer than the installed version; leave shipped notes untouched; write v0.1.2 notes.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 sheet layout** — the sheet is **portaled to `<body>`** (the real fix; test: the dialog is not a descendant of the header mount point) and the card is `border-box`, capped at `calc(100vh - 2×overlay padding)`, with a scrolling overlay (hardening). Proof: before/after screenshots at 800×560 (journal 2026-08-26).
2. **AC2 sheet filter** — with `current=0.1.0`, fetched `[0.1.1]`, bundled `[0.1.1, 0.1.0]`: the sheet renders v0.1.1 only; the v0.1.0 "Good to know" text is absent. With no fetched notes it falls back to bundled entries newer than current; with nothing newer it shows the manifest `notes`/"no release notes" hint.
3. **AC3 pack script** — `apps/whatsapp-sidecar/pack-helper.mjs --arch aarch64|x86_64` produces `<name>-darwin-<arch>.tar.gz` whose tree contains `index.js`, `package.json`, `bin/node`, `node_modules/baileys`, `node_modules/@snugprotocol/protocol`, `node_modules/zod`, and **no** `node_modules/@img` / `sharp`; the Node tarball is verified against `SHASUMS256.txt` (test: tampered sum → refusal). Pure planning functions unit-tested like `release-desktop.test.mjs`.
4. **AC4 release script** — `scripts/release-helper.mjs` signs both archives with minisign, writes `helper.json` (name, version, per-arch asset/sha256/size), refuses without a signing key, prints `gh release create --prerelease helper-<name>-v<ver>` and **stops** (test asserts the flag and the tag format).
5. **AC5 pinned resolution** — Rust: `REQUIRED_HELPERS` carries name, version, tag, per-arch sha256/size/unpacked size; `helper_status()` returns `{installed, kind: 'dev'|'downloaded'|'absent', installedVersion?, requiredVersion, mismatch: bool, downloadBytes, unpackedBytes}`; comparison is exact equality; a `dev` stamp (or stamp-less legacy tree = dev) is never overwritten and only flagged `mismatch`; a mismatched downloaded tree still **starts** and reports `mismatch` (never refused). `check-helper-pin` (root `pnpm test`) fails if the pin disagrees with `apps/whatsapp-sidecar/package.json` version.
6. **AC6 verify-then-extract** — Rust `helper_install`: (a) bad/missing `.sig` → refused, nothing written under `~/Snug/helpers/`; (b) pinned-sha256 mismatch (even with a valid signature) → refused; (c) entries with absolute paths, `..`, symlinks, hardlinks, devices → refused, `.partial-*` removed; (d) compressed cap and **inflated** cap exceeded → refused; (e) redirect to `http:` or to a host outside {github.com, objects.githubusercontent.com}, or >5 hops → refused; (f) happy path → two-rename swap, `helper.json { kind: 'downloaded' }` stamp written, `bin/node` is `0755`, helper started; (g) a `.old-*` left by a crash between the two renames is restored on next start; (h) a second install call while one is in flight joins it. Tests run against a local static server + a minisign key generated in the test.
7. **AC7 spawn** — `start_helper` uses `<helper>/bin/node` when present (no system-node preflight); dev install (no `bin/node`) keeps the existing preflights. Test on the source-text pin at `sidecar.rs:~1825` updated accordingly.
8. **AC8 playground seat** — `Platform` gains `helperStatus(name)` / `helperInstall(name, onProgress)` (desktop only). `beginDeviceLink` returns a typed `{ ok:false, reason:'helper-missing'|'helper-outdated', helper }` instead of the raw Rust string; the developer-facing "pnpm …" text never reaches the UI.
9. **AC9 install moment** — installing Telepath on desktop (RunView install path, after `installStarterConnections`) shows an inline card: "Telepath needs the WhatsApp helper — a 41 MB download from GitHub" with [download & install] / [not now]; progress; then the helper is started and the card clears. On web the card does not render.
10. **AC10 pairing moment** — LinkedDeviceScreen renders the same card (role `alert`, not a quiet hint) when `beginDeviceLink` reports helper-missing/outdated; after install it re-runs `beginDeviceLink` automatically.
11. **AC11 runtime moment** — a `net.ts` start failure caused by helper-missing surfaces in RunView's net band with the install CTA (typed error code, not lost as a generic net error).
12. **AC12 release gates** — `run-release-gate.mjs` MUST-APPEAR gains the helper download base URL; `release-desktop.mjs` refuses to stage when the pinned helper tag is not published (`gh release view`); `release-helper.mjs` refuses an existing tag; the gh line carries `--prerelease --latest=false`; C2 gate rows `ipc-helper-install-refused` (+ twin) added.
15. **AC15 autostart moment** — when `should_autostart` is true (linked session on disk) and the helper is absent/mismatched, a header chip (same pattern as the update chip) opens the install card; nothing is silent.
13. **AC13 docs/notes** — ADR-0060 accepted; ADR-0047 §12 amended; threat-model delta S9 added, R-e retired; architecture.md §Linked-device helpers + code-map rows; `desktop-releases.json` v0.1.2 entry ("the WhatsApp helper now downloads on demand…"); DownloadView copy; `well-known-providers.ts` instructions; `/sync-website` run; `docs/next-steps.md` spawner-stamp item closed.
14. **AC14 hardware walk** (owner, journaled) — fresh `~/Snug/helpers/`, install Telepath from the public build, accept download, pair a device end-to-end; x86_64 archive's `bin/node` runs under Rosetta.

**Out of scope**: an uninstall surface (residual, next-steps); auto-download without a click; updating helpers via the desktop updater; Windows; Node SEA; helpers other than `whatsapp-sidecar` (the mechanism is generic, only one entry ships); creating the actual GitHub helper release (explicit ask, own session).

## Plan

Order is tests-first per TDD.md; each phase is a commit group. Phase A is independent and small — it lands first.

**Phase A — update sheet (AC1–2)** · `apps/playground`
1. Test `desktop/__tests__/appUpdateSheet.test.tsx`: filter cases (AC2) + CSS contract (AC1). Red.
2. `AppUpdateControls.tsx`: `entries = fetchedNewer.length ? fetchedNewer : bundledNewer`; drop the history merge; keep tags.
3. `theme/app.css`: `.net-confirm-overlay { overflow-y:auto }`, `.release-notes-card { box-sizing:border-box; max-height:calc(100vh - 2*var(--space-4)) }`, `.net-confirm-actions { flex-shrink:0 }`. Screenshot at 800×560 via `tauri dev` → journal.

**Phase B — packaging + release scripts (AC3–4)** · `apps/whatsapp-sidecar`, `scripts/`
4. Tests `apps/whatsapp-sidecar/pack-helper.test.mjs`, `scripts/release-helper.test.mjs` (pure planning fns: asset plan, sha verification, helper.json assembly, gh command string). Red.
5. `pack-helper.mjs` (refactors the npm-install core out of `install-helper.mjs` so both share it; adds `--omit-optional`/explicit sharp exclusion, Node fetch+verify, `bin/node`, tar.gz). `install-helper.mjs` keeps its behaviour.
6. `release-helper.mjs` mirrors `release-desktop.mjs` (minisign via the same `TAURI_SIGNING_PRIVATE_KEY[_PATH]` path, `helper.json`, print-and-stop).

**Phase C — shell (AC5–7, AC12)** · `apps/desktop/src-tauri`
7. Cargo: name `minisign-verify`, `tar`, `flate2`, `tempfile` as direct deps (rationale comment as for reqwest).
8. Tests first in new `helper_install.rs`: stamp/pin logic, tar entry admission (traversal/symlink/hardlink), byte cap, redirect scheme, signature/sha refusal, happy path against a local HTTP stub (tokio + hand-rolled like the sidecar tests) with a test-generated minisign keypair.
9. Implement `helper_install(name)` command + `helper-install-progress` events; `sidecar_ctl('status')` gains the AC5 fields; `start_helper` prefers `bin/node`. Register command; capabilities unchanged (custom commands ride `core:default`).
10. Release gate MUST-APPEAR + pin-matches-package-version test.

**Phase D — playground UX (AC8–11)** · `apps/desktop/src`, `apps/playground/src`
11. Tests: `helperInstallCard.test.tsx`, `linkedDeviceHelperMissing.test.tsx`, `runViewHelperMissing.test.tsx`, `beginDeviceLink` typed-refusal test. Red.
12. `apps/desktop/src/sidecar.ts` + `platform-desktop.ts`: new seats. `platform.ts` types + doc comment.
13. `state/helperInstall.ts` (small store: idle/downloading(progress)/verifying/installing/done/error) + `connections/HelperInstallCard.tsx`; wire into RunView install path, LinkedDeviceScreen, RunView net band; `net.ts` throws a typed `HelperMissingError` code.

**Phase E — docs + notes (AC13)**
14. ADR-0060 → accepted; ADR-0047 amendment; threat-model delta S9/R-e; architecture.md; code-map.md; next-steps; `desktop-releases.json` v0.1.2 (bump stays for the release session); DownloadView; well-known-providers instructions; `/sync-website`; `check-website-sync`.

**Phase F — verification**
15. `pnpm test` root gate, `pnpm --filter desktop test:rust`, `gate:local`; owner hardware walk (AC14) journaled. Then `/code-review`.

**Cross-package impact**: `packages/auth` text-only (no behaviour); `packages/protocol` untouched (spec impact none); `apps/playground` ↔ `apps/desktop` seam widens by two optional Platform fields (web stays `undefined`, same pattern as `sidecarCtl`).

**Spec-sync**: none (no protocol change). Website: `/sync-website` after DownloadView/README wording.

**Open questions for approval** (defaults stated; proceed on these unless overridden):
- Q1 Node runtime in the archive (ADR-0060 §2) — default **yes** (≈ 41 MB per arch); the alternative keeps the system-Node dependency and is not "seamless".
- Q2 Helper releases as **pre-releases** on `snugprotocol/snug` (keeps `releases/latest` for the desktop) vs a separate `snugprotocol/helpers` repo — default same repo, pre-release.
- Q3 Same minisign key as the updater — default **yes**.

## Decisions & surprises

- The "Windows" line is not a bug in the trigger: it is the bundled v0.1.0 history rendered beneath the v0.1.1 entry by design (ADR-0047 §5 "Tesla-style" body).
- sharp/libvips is 42 % of the helper tree and is optional for baileys.

## Session journal (append-only, newest last)

### 2026-08-26 — Jeetu/Claude — session
- Done: investigation (sizes, spawn contract, sheet rendering path, CSS), task file, branch.
- Fresh-context plan review (High tier) returned 8 blocking + 9 non-blocking findings; all blocking ones folded into ADR-0060 §§3–7,10 and AC5/6/12/15 (content pin, two-rename swap, inflated cap, manual redirects with host allowlist, .bin symlinks dropped + `--omit=peer`, pinned Node sums in-repo, gate rows, unpublished-tag refusal, `--latest=false`). Declined: signed-manifest alternative (content pin in the shell achieves the same binding with less machinery).
- Phase A done `9376905`; Phase B scripts + tests green.
- Interview: owner rejected bundling → on-demand, separately released helpers (ADR-0060 draft); sheet shows only newer entries; shipped notes untouched, v0.1.2 notes new.
- State: plan written; **STOPPED for plan approval** (High tier: fresh-context AI plan review comes next, before code).
- Next step: approval → fresh-context plan review → Phase A.
- Open questions: Q1–Q3 in the plan.

### 2026-08-26 — Jeetu/Claude — approval
- Done: **plan approved by owner** with defaults Q1 (Node in archive: yes), Q2 (pre-releases on snugprotocol/snug), Q3 (updater minisign key). **Explicit ask recorded: create the actual helper GitHub release (`helper-whatsapp-sidecar-v0.1.0`, pre-release) in this session** — PROCESS.md release-rule requirement satisfied by this journal line.
- Next step: fresh-context AI plan review (High tier) → Phase A.

### 2026-08-26 — Claude — session (implementation)
- Done: Phases A–E implemented and committed on the branch; helper archives staged (`apps/whatsapp-sidecar/release-out/`, gitignored) and verified against the PRODUCTION updater key + pin from Rust (`staged_archive_verifies_against_the_production_key_and_pin`, run by hand); x86_64 archive's `bin/node` runs and the helper survives a 2 s start under Rosetta; `check-public-scrub` run by hand — OK.
- **AC1 root cause corrected**: not `max-height` — `.shell-header`'s `backdrop-filter` made the header the containing block for the fixed overlay mounted inside it. Reproduced with a static page + real stylesheets at 800×560 (before: dialog confined to the header, title-only visible; after: full sheet centred). Fix = `createPortal(…, document.body)` for the update sheet and the new helper sheet; CSS hardening kept.
- Gates: playground 1693/1693, desktop 188/188, cargo 116 (+1 ignored staged check), auth 939, sidecar 177, node:test scripts 12+, check-website-sync OK, root `pnpm test` green after renaming `pack-helper.test.mjs` → `.node-test.mjs` (vitest was collecting the node:test file).
- State: branch complete pending the helper GitHub release (explicit ask recorded above) and `/code-review`.
- Next step: create `helper-whatsapp-sidecar-v0.1.0` as a **pre-release, `--latest=false`**, verify `releases/latest/download/latest.json` still resolves to the desktop v0.1.1, then code review → PR.
- Owner walks owed (AC14): see next-steps 2026-08-26 entry.
