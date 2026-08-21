# TASK-20260821-hardening-polish: Hardening and polishing (six-item umbrella)

- **Status**: planned (awaiting owner plan approval)
- **Owner**: jeetu
- **Risk tier**: **high** — touches desktop release config (High-tier area), the threat model, C2-adjacent capability config, and e2e-load-bearing UI strings. High tier ⇒ fresh-context AI plan review BEFORE implementation + negative tests + journal self-sign-off.
- **Branch**: `feat/TASK-20260821-hardening-polish`
- **Packages touched**: `apps/playground`, `apps/desktop` (incl. `src-tauri` config + capabilities), `examples/*`, `docs/` (threat model, security deltas, decisions), `scripts/` (checkers, release script). `packages/*` untouched (verify at review).
- **Spec impact**: none — no `packages/protocol` schema change. The platform-seam addition (`appUpdates`) is playground-internal; updater config is shell-level; release notes are static data.
- **Related**: ADR-0042/0043 (.snug + encryption), ADR-0045 (starter versioning + update channel — the doctrine + schema this task reuses), ADR-0046 (multi-provider BYOK / deep delete), ADR-0021 D8 (macOS-only), ADR-0013 (hosted hub static-only), TASK-20260820-threat-model-v1; next-steps: trivia-night removal (2026-08-20 owner statement), installer/signing/download links (2026-08-12 item 5), AL-15 (held — the hub remains the download surface).

## Spec (what & why)

Owner-directed umbrella "Hardening and polishing", six sub-items (owner interview 2026-08-21 resolved the open calls — recorded under Decisions):

1. **Threat model v2 (targeted)** — fold post-`7097dac` merges (ADR-0045 update
   channel, ADR-0046 BYOK/deep delete) AND this task's new desktop-updater/download
   surface into §5/§6 with a focused adversarial pass on those surfaces only; bump the
   stale header to 2.0; restore the delta-ledger convention by writing the missing
   delta files; re-point retired spec-draft filenames.
2. **Desktop download + update channel** — the web hub offers a macOS download link
   (GitHub Releases on `snugprotocol/snug`); installed desktop clients detect newer
   releases and offer an OPT-IN update with Tesla-grade structured release notes
   (ADR-0045 schema + `ReleaseNotesSheet` precedent). No auto-apply. Apple signing
   planned-for but env-gated (owner will obtain a Developer ID; unsigned until then,
   honestly disclosed). Tauri minisign updater key generated now (custody: owner).
3. **Remove trivia-night permanently** (shelf + repo; installed user copies are
   user-owned and untouched).
4. **Hide the per-app "export .snug" header control** — code path stays behind a
   single flag; Settings whole-file export untouched.
5. **Mobile run view: either/or toggle** — on ≤760px the think toggle swaps the WHOLE
   view between app and "watch it think" (replaces the bottom-sheet modal); default is
   ALWAYS the app view on mount (not persisted — owner's "default should always be app
   view"). Desktop (>760px) split/divider behavior byte-identical.
6. **Starter wiki docs everywhere + version bumps** — full Ledger-style authoring set
   (vision/requirements/plan/lessons/next-tasks + build-prompt) for chess, flying-pig,
   adventure-quest, quiz-me (retrospective, labeled as such); complete github
   (next-tasks) and weather (lessons, next-tasks); bump `starter.json` on every
   starter shipping an authoring bundle so installed copies take the docs via the
   ADR-0045 in-place update (absent-only seed; owner's installs predate seeding).

**Acceptance criteria** (each becomes ≥1 test; test file targets in the plan):

- AC1 (item 3): `examples/trivia-night` is gone; `APPS`/`LLM_FREE_APPS`/`KEEPER_FOLDERS`/`STARTER_LOOKS` agree; examples validate + starterShelf suites green at 12 folders.
- AC2 (item 3): every deleted trivia e2e assertion is classified — the LLM-free zero-networking journey claims MIGRATE to `flying-pig` (the only other `LLM_FREE_APPS` member), none silently LOST.
- AC3 (item 4): with `sawDbOp` true, the run header renders NO export control; the code path survives behind one flag and a test drives the flag BOTH ways (hidden now / restorable later). Header order test updated (model select → connections).
- AC4 (item 4): Settings export (incl. include-secrets + import) suites untouched and green; the two e2e locators on `export .snug` are MIGRATED (assert header absence + exercise export via Settings), not deleted.
- AC5 (item 5): ≤760px — toggle swaps full app view ⇄ full think view; app view on every mount; `aria-pressed`/labels honest; NO dialog remains in the run path. Component test + migrated `mobile.spec.ts` (Playwright asserts the iframe is actually hidden/shown — geometry, not class names).
- AC6 (item 5): >760px — rail toggle, divider drag, width persistence byte-identical (existing `railLayout` suites stay green, zero edits to their assertions).
- AC7 (item 6): validator gains a floor — EVERY starter ships `authoring/docs/{vision,requirements,plan,lessons,next-tasks}.md` + ≥1 `prompts/*.md`; the four retro build-prompt pages carry an explicit retrospective label (validator-checked).
- AC8 (item 6): every `starter.json` bumped ships a changelog entry matching the new version; `appHash` rules stay green; hub offers "update · vN" for a previously-installed copy (existing `starterUpdate` suite pattern extended for a docs-only release).
- AC9 (item 2): one version, three files — a test pins `apps/desktop/package.json` == `tauri.conf.json` == `Cargo.toml` versions.
- AC10 (item 2): `tauri.conf.json` carries `createUpdaterArtifacts` + `plugins.updater` (pubkey + the GitHub Releases `latest.json` endpoint); endpoint/download URLs are single-homed in ONE constant consumed by both the shell config check and the playground download surface (byte-compare test — one contract, never two artifacts).
- AC11 (item 2): `release-desktop.mjs` — version bump across all three sites, refuses without a matching `releases.json` changelog entry (ADR-0045 schema), emits `latest.json` with the minisign signature, signing/notarization env-gated with an honest unsigned path; pure parts covered by node:test (bump, refusal, latest.json shape). It NEVER publishes on its own — `gh release create` is a separate explicit-ask step, recorded in the journal per run.
- AC12 (item 2): web hub — the inert "needs the desktop app — free download" badge becomes a link to a `/download` page: macOS-only copy, honest Gatekeeper disclosure while unsigned, current version + Tesla-style structured release notes rendered from `releases.json`. Desktop shell shows NO download surface (platform-gated). Component tests both ways.
- AC13 (item 2): desktop update UX — platform seam gains optional `appUpdates`; a NON-BLOCKING "update available" affordance (header/Settings chip — never a gate in front of the hub), release-notes sheet with installed-vs-new tagging, "update now" (download/install/relaunch) and "later". Mocked-seat component tests + a seam identity test from the integrating side. A failed/unreachable check is quiet on launch and NAMED on manual check (private repo pre-flip ⇒ endpoint 404s unauthenticated — this state is designed-for, not an error banner).
- AC14 (item 2): C2/negative — the updater permission lands in the main-window capability only; the desktop gate's IPC-unreachability checks stay green; `gate:release` still proves debug surfaces absent from a release binary.
- AC15 (item 1): `threat-model.md` v2.0 — §5/§6 rows for the starter update channel, multi-provider BYOK, deep delete, and the desktop update channel (minisign key custody, latest.json trust, GH Releases integrity); retro + new delta files hash-pinned in `DELTA-LEDGER`; `check-threat-model.mjs` green with grown coverage; spec references point at `SPEC-v0.3-draft.md`.
- AC16: ADR-0047 "Desktop distribution and update channel" recorded (hosting choice, offered-not-auto doctrine inherited from ADR-0045, key custody, signing posture).

**Out of scope**: actually publishing the first GitHub release (own explicit ask when the pipeline is proven); Apple credentials themselves; anything Windows (ADR-0021 D8); AL-15 landing page; auto-apply updates (rejected, ADR-0045 doctrine); purging trivia-night from installed user files, git history, or `done/INDEX.md` historical records; the four starters-connect quarantined reds (pre-existing).

## Plan

**Order** (small → large, threat model last so it covers the task's own surfaces; one branch, task-id-prefixed commits per item):

**P1 — trivia-night removal (item 3).** Tests first: update `examples/validate.test.mjs` `APPS`+`LLM_FREE_APPS`, `starterShelf.test.tsx` `KEEPER_FOLDERS` (red against present folder), then delete `examples/trivia-night/`, remove `HubView.tsx:39` `STARTER_LOOKS` entry, migrate `e2e/starters.spec.ts` LLM-free journey to flying-pig, prune `examples/README.md` row + `code-map.md:72` mention, prune the stale next-steps line at Gate 6. Watch: `sample-mode.test.mjs` mentions trivia — check and update.

**P2 — hide header export (item 4).** Tests first in `runHeaderIcons.test.tsx` (absence + flag-restore) and `connectionSurfaces.test.tsx` (new order). Implement: one module-level flag in `RunHeaderActions.tsx` (comment citing this task + the restore path), header comment updated (its "load-bearing string" note now points at Settings). Migrate `snugFileNaming.test.ts:46` + both `starters.spec.ts` locators to the Settings export path. `exportDb.ts` untouched (Settings imports `downloadBlob`). `sawDbOp` wiring untouched.

**P3 — mobile either/or (item 5).** Tests first: new `mobileViewToggle.test.tsx` (matchMedia-mocked: default app on mount, swap, toggle labels/aria, remount resets to app) + rewrite `e2e/mobile.spec.ts` (no `role=dialog`; assert iframe hidden when think shown, visible again on toggle back). Implement in `RunView.tsx`: mobile branch replaces `Sheet` with local `mobileView: 'app' | 'think'` state (`useState('app')`, never persisted); toggle button replaces the `inspect` button; `.run-stage` and rail content swap via a `.run-layout.is-mobile-think` class; CSS in `app.css` @760px block. Desktop branch untouched (AC6 = zero edits to `railLayout.test` assertions). `Sheet` component itself stays (other consumers).

**P4 — starter docs + version bumps (item 6).** Validator floor first (red: 6 starters incomplete), then author: full retro sets for chess/flying-pig/adventure-quest/quiz-me (from code + git history; build-prompt labeled retrospective), `github/authoring/docs/next-tasks.md`, `weather/authoring/docs/{lessons,next-tasks}.md`. Bump `starter.json` (version+changelog; appHash unchanged — html untouched) for all 12 doc-bearing starters so installed copies get the absent-only docs seed via update. Extend `starterUpdate.test.ts` with a docs-only release row (update offered on version alone, docs seeded, html byte-identical ⇒ still "unedited" path).

**P5 — desktop download + update channel (item 2).** The big one; sub-order:
  1. **ADR-0047 draft** (decision being made — hosting=GH Releases, offered-not-auto, minisign custody, env-gated Apple signing).
  2. **Version single-sourcing**: new `apps/desktop/src/__tests__/versionSync.test.ts` (AC9) — read all three files, assert equality.
  3. **Updater config**: add `tauri-plugin-updater` (Cargo + capability entry main-window-only) + `tauri-plugin-process` (relaunch); `bundle.createUpdaterArtifacts: true`; `plugins.updater.endpoints = [<RELEASES_LATEST_JSON_URL>]` + `pubkey` (minisign keypair generated this task; private key NEVER committed — owner keychain/env; document custody in ADR-0047). Config pinned by extending `bundleTargets.test.ts`'s sibling — new `updaterConfig.test.ts` (AC10). URL constant single-homed: `apps/desktop/src/releaseChannel.ts` (or shared const file) with a byte-compare test against `tauri.conf.json` AND the playground download page import.
  4. **Structured release notes**: `apps/desktop/releases.json` (ADR-0045 `StarterRelease[]` schema, v0.1.0 entry authored now); parsed by a small shared reader (reuse `starterMeta.ts` parsing doctrine — tolerant at runtime, strict in tests).
  5. **Release script** `apps/desktop/scripts/release-desktop.mjs` (AC11) + node:test file. Steps: bump 3 version sites → refuse without matching `releases.json` entry → `gate:release` → `tauri build` (updater artifacts; signing env-gated: `APPLE_SIGNING_IDENTITY`/notarize vars present ⇒ sign+notarize, absent ⇒ warn-and-continue unsigned) → emit `latest.json` (version, pub_date, platforms.darwin-{aarch64,x86_64} url+signature, notes pointer) → print the `gh release create` command it did NOT run.
  6. **Web download surface** (AC12): `/download` route in `app.tsx`; `DownloadView` (macOS-only copy, Gatekeeper disclosure while unsigned, version + release notes from `releases.json`, download href to the GH release asset URL); `HubView` badge → `Link`; `SettingsView` web row "get the desktop app". All platform-gated (`platform.kind`).
  7. **Desktop update UX** (AC13): platform seam optional `appUpdates` seat (`currentVersion`, `check()`, `downloadAndInstall(onProgress)`, `relaunch()`); desktop impl over the updater plugin JS API; playground: launch check (quiet-fail) + Settings "check for updates" (named-fail) + non-blocking header chip → `AppUpdateSheet` (Tesla-style: cumulative entries from the release's notes payload, installed-vs-new tags — same rendering family as `ReleaseNotesSheet`) → update now / later. Seam identity test from the integrating side (lessons 2026-08-13).
  8. **C2/negative** (AC14): capability diff review; run desktop gate + `gate:release` locally.
  Residual to disclose in ADR + threat model: while the repo is private, unauthenticated `latest.json` fetches 404 — launch-check is quiet by design; owner testing uses a header-token override (dev-only, env-injected, never shipped enabled).

**P6 — threat model v2 (item 1).** After P1–P5 are code-complete. Write delta files: retroactive `threat-model-delta-snug-encryption.md` (convention repair, references ADR-0042/0043 — content already folded, delta records it), `threat-model-delta-starter-update-channel.md` (ADR-0045), `threat-model-delta-multi-provider-byok.md` (ADR-0046 incl. deep delete), `threat-model-delta-desktop-update-channel.md` (this task). Adversarial pass focused on: update-channel supply chain (key custody, latest.json substitution, GH account compromise, TOFU on first download), BYOK second-provider credential surface, deep-delete erasure completeness. Amend `threat-model.md` → Version 2.0 (header + §2/§5/§6/§8 rows; spec-draft file re-pointing), update `check-threat-model.mjs` pins, keep 100% green.

**Cross-package impact**: playground+desktop (seam + config), examples (content + validator), scripts (release + checker), docs. No `packages/*` source change ⇒ dependent-suite risk is low, but run root `pnpm test` + `gate:local` legs (`workspace`+`smoke` minimum; `e2e`+`desktop`+`release` for P3/P5) before merge.

**Test plan summary (tests FIRST per TDD.md)**: every AC above names its file; reds verified via `git show HEAD:<path>` restores (lessons 2026-08-20), mutation checks on: the export flag (both ways), the validator floor (remove a doc ⇒ red), version-sync (desync one file ⇒ red), URL single-homing (drift ⇒ red), updater-capability absence (AC14 positive twin: the main window CAN reach the updater command).

**Spec-sync**: not triggered (no `packages/protocol` change). Re-assert at Gate 5.

## Plan review round 1 (fresh-context, 2026-08-21) — 21 confirmed findings, all accepted; resolutions

Workflow: 4 lenses (security/feasibility/testplan/scope) + per-finding refuters (25 agents); 0 findings refuted. Amendments below are BINDING on the plan above.

1. **[blocker] Docs-only starter releases cannot deliver (findings 6+12).** P4 gains an explicit `starterUpdate.ts` step: (a) the already-current branch still runs the absent-only `installStarterDocs` (decision: the declared-only connection refresh does NOT run there — nothing in a docs-only release changes connections) before returning; (b) the offer side treats an html-identical bundle with a HIGHER `meta.version` than the recorded/derived version as update-available (the docstring's "can only over-offer, never hide" invariant is falsified by docs-only releases — amend the doctrine comment in the same change); for legacy no-row copies, derivation records the matched version but the docs catch-up still lands via (a) when the user takes the offered no-op update. Classify the existing idempotence test: its "writes nothing" claim becomes "writes no VERSION and no HTML" (docs seed is absent-only, so a second apply still writes nothing — assert that explicitly). Mutation check: remove the seed call in the already-current branch ⇒ AC8 red. Packages-touched now includes `apps/playground/src/starter/`.
2. **[major] Updater IPC gate rows (finding 0).** AC14 rewritten: per-command NEGATIVE rows `ipc-updater-check-refused`, `ipc-updater-install-refused`, `ipc-process-relaunch-refused` in `gate/ipc.ts` (keyless srcdoc probes, same weaker-instrument + keyReachable pattern as `lan_fetch`), paired with the positive twin from the main frame. Capability placement alone proves nothing per the gate file's own amendment-16 doctrine.
3. **[major] Header-token override is dead and dangerous (findings 1+10+19).** DROPPED entirely — no GitHub PAT anywhere in the shell, ever. Pre-flip owner testing uses an env-injected dev-only ENDPOINT override (local static stub serving latest.json + artifact), `cfg(debug_assertions)`/DEV-gated on the net-remap precedent, its env var added to `run-release-gate.mjs` NEEDLES (present-in-debug positive control, absent-in-release). AC10's byte-compare pins the PRODUCTION constant; the override never touches `tauri.conf.json`.
4. **[major] minisign covers the artifact, not latest.json (finding 2).** Fetched `latest.json` fields (version/notes/urls) are TRUSTED-ON-TLS-ONLY display data: version syntax-validated, notes rendered as plain text with NO actionable URLs, the sheet says when notes are unavailable. The structured Tesla-style notes come from the fetched release's `releases.json` asset under the same rules. ADR-0047 + the delta file state the trust split explicitly (GH-compromise can lie in the PROMPT, cannot install a binary).
5. **[major] Relaunch vs sidecar reap + single-instance lock (finding 3).** The update flow is: `downloadAndInstall` → explicit shell shutdown-prep (reap sidecar via the existing TERM-first path, remove pidfile) → relaunch. Before implementation, read `tauri-plugin-process`/updater source and write a verdict in this file on whether relaunch drives `RunEvent::Exit` (suspected NO — `std::process::exit` class); the pre-relaunch reap makes the answer not load-bearing. Cargo/source test pins reap-before-relaunch ordering; the real relaunch walk (lock race included) joins the owner manual-test list — no suite can perform it.
6. **[major] Three trivia e2e specs, not one (finding 7).** P1 dispositions: LLM-free journey → `flying-pig` (claims adapted to a canvas game: renders, zero network); zero-trace export guard + install-after-browsing persistence → `quiz-me` (textbox → deterministic SQL write preserved); `STARTER_TABLE_MARK` byte assertion kept verbatim.
7. **[major] Mobile spec claim disposition (finding 13).** AC5 gains the table: rail-tab accessible-name pin + uninstalled-starter tab gating MIGRATE into the full think view; ≥44px touch target MIGRATES to the toggle button; `expectNoHorizontalScroll` re-asserts in BOTH view states; only the `role=dialog` assertions are OBSOLETE (Sheet mount deleted).
8. **[major] Launch-check wiring test (finding 14).** AC13 gains: shipping-composition-root test with a spy `appUpdates` seat asserting `check()` fires on launch + mutation twin (delete the wiring ⇒ red); Settings manual-check asserts the NAMED failure sentence from the spy's rejection.
9. **[major] Release-script tests need a runner (finding 15).** Root script `check-release-desktop` (node:test) added to root `package.json` and run by `pnpm test`, matching the check-gate-local pattern; mutation check included.
10. **[major] Dependency direction (finding 16).** URL constant + `releases.json` live in the PLAYGROUND (`apps/playground/src/releaseChannel.ts`; releases data beside `starterMeta.ts`'s parsing doctrine); desktop consumes via its existing `@playground` alias; desktop-side `updaterConfig.test.ts` BYTE-COMPARES the constant against `tauri.conf.json`; the release script reads by filesystem path. No playground→desktop import, ever.
11. **[major] Duplicate R-14 (finding 17).** P6 renumbers the encryption R-14 to the next free ID, sweeps every citing surface (next-steps, delta ledger, SECURITY.md), and adds an ID-uniqueness check to `check-threat-model.mjs`.
12. **[major] Arch story (finding 8).** Universal build: `tauri build --target universal-apple-darwin`; both darwin platform keys point at the one artifact; rustup target additions documented in ADR-0047; release-script test pins latest.json platform keys ⇄ artifacts produced. Fallback (recorded, not preferred): aarch64-only with honest latest.json.
13. **[minor] releases.json schema (finding 9).** ADR-0045 sections/items SHAPE with a semver `version` string; own strict-in-tests schema; rendering family reuse only.
14. **[minor] Launch check is a phone-home (finding 4).** Automatic check ships ON with a Settings toggle ("check for updates automatically"); the delta file names the channel (what GitHub learns, how often). Owner can flip the default at the manual walk if it feels wrong.
15. **[minor] Helper skew (finding 5).** Scoped OUT with disclosure: ADR-0047 + delta row state the helper is not distributed/updated by this channel; the spawner version-stamp check stays the filed next-steps fix.
16. **[minor] Stale plan claims (finding 11).** Spec-draft re-pointing sub-step DROPPED (nothing to re-point); sample-mode watch item DROPPED; `app.tsx` → `App.tsx`.
17. **[minor] Release rules (finding 18).** This task adds one line to PROCESS.md §Release & publish rules + the CLAUDE.md/AGENTS.md/GEMINI.md rule-4 mirrors: GitHub Releases on snugprotocol repos require an explicit human ask per session + journal record.
18. **[minor] One branch (finding 20).** CONSCIOUS DECISION: one branch per the owner's "under one task" instruction, commits strictly per-item (P1…P6 prefixes) so items can be split out if P5 stalls. Risk accepted and recorded.

## Decisions & surprises

- (2026-08-21, owner interview) Hosting = **GitHub Releases now** on `snugprotocol/snug` (private pre-flip; unauthenticated updater 404s until flip — designed-for, disclosed). Apple ID = **"I'll get one — plan for it"**: full signing path wired, env-gated, unsigned fallback until credentials exist. TM v2 = **targeted** (not a full re-audit). Starter docs = **full Ledger-style retro sets** incl. reconstructed build-prompt labeled retrospective.
- (2026-08-21, decided in plan) Mobile view choice is NOT persisted — app view on every mount, per owner's "default should always be app view".
- (2026-08-21, decided in plan) The hub is the download surface (AL-15 stays held); the existing desktop-only tile badge becomes the link.
- (2026-08-21, research) Threat model was ALREADY amended in place by the encryption task — v2's work is the post-`7097dac` merges + this task's surfaces; header version line is stale at 1.0.
- (2026-08-21, research) No updater infra exists (no plugin, no signing, versions declared in 3 unsynced files). ADR-0013 constrains hosted-hub serving to static; GH Releases satisfies it.
- (2026-08-21, research) "export .snug" accessible name is load-bearing for 2 e2e specs + 4 unit suites (lessons 2026-08-18) — migrate claims, never delete.
- (2026-08-21, research) Mobile run view is currently a bottom-sheet modal, not a split — item 5 replaces the modal with a full-view swap.
- (2026-08-21, research) `authoring/` missing only for the 4 LLM-free keepers (+trivia); github/weather partial; the flagship six are complete. Installed copies predate doc seeding ⇒ version bumps deliver docs via ADR-0045's absent-only seed.

## Session journal (append-only, newest last)

### 2026-08-21 — claude (with jeetu) — session
- Done: Gate 1+2 — repo research (4 parallel surveys), owner interview (hosting,
  signing, TM depth, docs authorship), plan written, ADR-0047 to be drafted with P5.
- State: plan awaiting owner approval; no implementation code written.
- Next step: owner approves plan → fresh-context AI plan review (High tier) → branch
  work begins at P1.
- Open questions: none blocking; first real `gh release create` will need its own
  explicit ask in a future session.
