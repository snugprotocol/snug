# TASK-20260824-first-signed-release: First signed + notarized macOS Release (universal)

- **Status**: in-review (released; PR open)
- **Owner**: Jeetu
- **Risk tier**: **high** (auto-escalated — release config + GitHub Release creation; ADR-0047 §13, PROCESS.md §Release & publish rules)
- **Branch**: `feat/TASK-20260824-first-signed-release`
- **Packages touched**: `scripts/` (release-desktop.mjs + test), `apps/desktop/src-tauri` (tauri.conf.json macOS/entitlements), `apps/playground` (DownloadView Gatekeeper copy), `apps/website` (download.astro copy), `docs/` (ADR, threat-model R-29, next-steps)
- **Spec impact**: none (no `packages/protocol` change)
- **Related**: ADR-0047 (desktop distribution + update channel), ADR-0055 §2 (DMG EULA clickwrap), ADR-0045 (offered-not-auto updates), ADR-0021 D8 (macOS-only), threat-model R-29, next-steps 2026-08-24 item (2)

## Spec (what & why)

Snug desktop has a complete, tested release pipeline (`scripts/release-desktop.mjs`, ADR-0047 §§6-8) that has never produced a real release. It builds `--target universal-apple-darwin` already, minisign-signs updater artifacts, verifies the DMG carries the EULA, and prints the `gh release create` command without running it.

The one thing it has never done is **Apple code-signing and notarization**. ADR-0047 §7 promised these would be "wired but env-gated"; in fact only `APPLE_SIGNING_IDENTITY` is read, and only as a boolean to decide whether to print a warning. No notarization call, no hardened runtime, no entitlements, no staple, no verification. The Developer ID enrollment landed 2026-08-23 (individual) but **no Developer ID Application certificate is installed in this machine's keychain** (`security find-identity -v` → 0 valid identities).

This task closes ADR-0047 §7 for real and ships **v0.1.0** as the first signed, notarized, stapled, universal (arm64 + x86_64) GitHub Release — then retires the Gatekeeper disclosure copy and threat-model R-29.

**Acceptance criteria** (each becomes at least one test):

1. **The release script REFUSES a build whose universal binary is not fat.** A new pure export `checkUniversalArchs(lipoOutput)` accepts only output naming BOTH `arm64` and `x86_64`; anything else (Intel-only, arm-only, garbage, empty) returns a named refusal. Wired into `main()` via `lipo -archs` on the built `.app`'s Mach-O before staging. *(Directly answers "must be universal, not Intel-only" with a gate rather than a hope.)*
2. **Apple signing is real, not a boolean.** With `APPLE_SIGNING_IDENTITY` set, the build runs with hardened runtime + the entitlements file; a new pure `appleSigningPlan(env)` returns `{mode:'signed'|'unsigned', reason}` and refuses the half-configured states (identity set but no notary profile; notary profile set but no identity). Unit-tested across the whole env matrix.
3. **The DMG and .app are notarized AND stapled, and the script proves it.** A pure `checkStapleOutput` / `checkSpctlOutput` pair parses `xcrun stapler validate` and `spctl -a -vvv -t install` output; the script refuses on anything but acceptance. *(A notarization that succeeds but never staples is the classic silent failure — an offline first-launch then fails.)*
4. **Notarization does not break the EULA clickwrap.** The existing `verifyDmgCarriesEula` check runs AFTER stapling, not before (review F9's unverified interaction — stapling rewrites the DMG). Ordering is asserted by the script's own flow and confirmed by the real run.
5. **Both updater platform keys still point at the one universal artifact.** Existing `buildLatestJson` behaviour, re-pinned by a test that asserts `darwin-aarch64` and `darwin-x86_64` share an identical `{signature,url}` object.
6. **The three version declarations agree at 0.1.0** and `desktop-releases.json`'s newest entry is v0.1.0 (existing `versionSync.test.ts` + `changelogEntryFor`; both already green — re-run, don't rewrite).
7. **`pnpm --filter desktop gate:release` stays green** — the release binary carries the production updater endpoint and none of the debug gate surface. Unchanged mechanism; must not regress under the new build flags.
8. **After a verified notarized DMG, the Gatekeeper disclosure is gone.** The right-click→Open paragraphs are removed from `apps/playground/src/views/DownloadView.tsx` and `apps/website/src/pages/download.astro`; threat-model R-29 is retired (rewritten as resolved with the date + identity, not deleted); `pnpm run check-website-sync` stays green.
9. **The release is published and journaled.** `gh release create v0.1.0` on `snugprotocol/snug` with the five stable assets, then a journal entry recording what/when-UTC/verification (PROCESS.md §Release & publish rules, ADR-0047 §13).

**Out of scope**: CI-side signing (keys never leave the owner's shell — ADR-0047 §4); Windows/Linux targets (ADR-0021 D8); the full update *walk* v0.1.0→v0.1.1 (needs a second release, its own ask — stays in next-steps); Mac App Store distribution; changing the hosting choice off GitHub Releases; the WhatsApp helper's distribution (ADR-0047 §12).

## Plan

**Owner 🔑 prerequisites (blocking; nothing below can run without them).** This Mac has Xcode 26.6 and both rustup darwin targets, but `security find-identity -v` reports **0 valid identities**. Before implementation reaches step 4:
- Create a **Developer ID Application** certificate in the Apple Developer portal and install it into the login keychain (`security find-identity -v -p codesigning` must then list it).
- Create a notarytool credential profile: `xcrun notarytool store-credentials "snug" --apple-id jeetumaker@gmail.com --team-id <TEAM_ID> --password <app-specific-password>`.
- Export in the build shell only: `APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAM_ID>)"`, `APPLE_KEYCHAIN_PROFILE="snug"`, `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/snug-updater.key` (+ `_PASSWORD` if set).

**Credential mechanism (owner decision, this session): notarytool keychain profile.** No app-specific password in env or shell history; no .p8 private key to custody. Cost recorded: it is machine-local, so a future CI signer would need a different mechanism — acceptable, since ADR-0047 §4 already forbids keys in CI.

### Files to touch, in order

1. `scripts/release-desktop.test.mjs` — **tests first** (Gate 3, TDD.md). New cases for `checkUniversalArchs`, `appleSigningPlan`, `checkStapleOutput`, `checkSpctlOutput`, and the both-keys-one-artifact assertion on `buildLatestJson`. Each new pure function gets its refusal paths pinned, including the broken-tooling shapes (empty string, unexpected output) — the release-gate's positive-control doctrine: a parser that can only pass is not a check.
2. `scripts/release-desktop.mjs` — the new pure exports, then `main()` rewiring in this order: gate → build (signed) → **notarize + staple** → **staple/spctl verify** → **lipo verify** → **EULA verify (now after stapling)** → stage → print `gh`. The unsigned path keeps working and keeps warning (a cert-less machine must still be able to build).
3. `apps/desktop/src-tauri/entitlements.plist` — **new.** Hardened runtime needs `com.apple.security.cs.allow-jit` (WKWebView JS) and `allow-unsigned-executable-memory` only if the build proves they're required; start minimal and add only what a failing launch demands. *Nothing here weakens C1/C2 — entitlements govern the process, not the app-iframe sandbox.*
4. `apps/desktop/src-tauri/tauri.conf.json` — add `bundle.macOS` with `entitlements`, `minimumSystemVersion`, and `signingIdentity`/`hardenedRuntime` as Tauri 2 spells them. **Cross-package impact:** `bundleTargets.test.ts` reads this file and forbids non-macOS targets — adding a `macOS` block must not trip it; check the test's shape assertions before editing.
5. `apps/desktop/src/__tests__/updaterConfig.test.ts` — re-run; the byte-compare against `releaseChannel.ts` must still hold after the config edit.
6. **The real build**: `node scripts/release-desktop.mjs 0.1.0` with the env set. Then owner walk — mount the DMG, read the Agree screen on real glass, confirm Gatekeeper opens it with a plain double-click (not right-click→Open) on a machine that has never seen the cert.
7. `apps/playground/src/views/DownloadView.tsx` + `apps/website/src/pages/download.astro` — remove the Gatekeeper paragraphs **only after step 6 passes**. Then `pnpm run check-website-sync`.
8. `docs/threat-model.md` — R-29 rewritten as resolved (date, identity type, what remains: first acquisition is still TOFU — that half of R-29 does NOT go away and must survive the edit).
9. `docs/decisions/0047-desktop-distribution-and-update-channel.md` — status line → `accepted (amended 2026-08-24 — §7 signing/notarization implemented; see Amendment)` plus an in-file `## Amendment — 2026-08-24` section recording that §7 was aspirational, what the real mechanism is, and the keychain-profile choice. Follows the ADR-0028/0038 in-file amendment precedent; ADR-README's "status line only" rule governs *superseding* ADRs, not self-amendments.
10. `docs/next-steps.md` — prune item (2) of the 2026-08-24 block and the 2026-08-21 item (5) per ADR-0027 (distill, don't append); leave the v0.1.0→v0.1.1 update walk open.
11. **Publish** — `gh release create v0.1.0 …` (explicitly asked for in this session; still confirmed at the moment of running) + journal entry.

### Test plan (tests FIRST)

- `node --test scripts/release-desktop.test.mjs` — the new pure functions, red before green.
- `pnpm --filter desktop test` — bundle targets, updater config, version sync, DMG EULA.
- `pnpm --filter desktop gate:release` — release inertness + must-appear endpoint.
- Root `pnpm test` before PR (it runs `check-release-desktop` + `check-website-sync`).
- `pnpm run check-public-scrub` **by hand** before publishing (ADR-0057 — the tooling is gitignored, so no gate runs it for us; a release is exactly the moment it exists to guard).
- Unautomatable, owner-verified: Gatekeeper double-click on a clean machine, the SLA Agree screen, `spctl` acceptance of the stapled DMG.

### Spec-sync impact

**None.** No `packages/protocol` change → no `SPEC_SYNC.md` step, no spec-changelog entry.

### Risk notes

- **High tier** for two independent reasons: release/CI config, and creating a GitHub Release every installed client will trust (ADR-0047 §13). Requires a fresh-context AI plan review before implementation + explicit self-sign-off in the journal.
- **Irreversibility:** `latest.json` published at `releases/latest/download/` is what every future client polls. A bad v0.1.0 is fixable only by publishing v0.1.1 — deleting a release that clients already fetched is worse than superseding it.
- **The minisign key is single-custody** (`~/.tauri/snug-updater.key`, no escrow — ADR-0047 §4). Losing it orphans every installed client's update path. Worth confirming a backup exists before publishing the first release that anyone installs.

## Decisions & surprises

- **2026-08-24 — the universal build is already correct.** `release-desktop.mjs` builds `--target universal-apple-darwin` and `buildLatestJson` points BOTH `darwin-aarch64` and `darwin-x86_64` at the one artifact. Both rustup targets are installed. The user's "make sure it is universal, not Intel-only" concern is already satisfied by the code; this task must *verify* it on the built artifact (`lipo -archs`) rather than change it.
- **2026-08-24 — ADR-0047 §7 overstates what exists.** "Signs and notarizes when the env vars are present" is not implemented: `APPLE_SIGNING_IDENTITY` is read once as a boolean for a warning. Notarization/stapling/hardened-runtime/entitlements are entirely absent. The ADR needs an amendment or a superseding entry.
- **2026-08-24 — owner decisions (Gate 1 interview).** (a) Owner creates the Developer ID cert + notarytool profile now; the real signed build happens in this session. (b) ADR-0047 §7 is corrected by an **in-file amendment**, not a new ADR. (c) Notary credentials via **notarytool keychain profile** (`--keychain-profile`), not env passwords and not an ASC API key. (d) Full scope: universal-arch assertion, Gatekeeper-copy removal, owner DMG walk, **and publishing the Release** — selecting that option is the explicit per-session ask ADR-0047 §13 requires.
- **2026-08-24 — hard blocker: no signing certificate on this machine.** Apple Developer account is enrolled, but no Developer ID Application cert is in the login keychain. Signing cannot proceed until the owner creates the cert + an `AC_PASSWORD`-style notarytool credential profile (or App Store Connect API key).

## Session journal (append-only, newest last)

### 2026-08-24 — Jeetu — session (Gate 1)
- Done: read PROCESS.md, ADR-0047, `release-desktop.mjs`, `run-release-gate.mjs`, `releaseChannel.ts`, `desktop-releases.json`, bundle-target test; probed the local toolchain (Xcode 26.6, both rustup darwin targets present, minisign key present at `~/.tauri/snug-updater.key`, **0 codesigning identities**).
- Done (cont.): ran the Gate 1 interview; wrote the Gate 2 plan (9 acceptance criteria, 11 ordered steps, test plan, risk notes) into this file; created the branch.
- State: **Gate 2 — plan written, STOPPED for owner approval.** No implementation code written.
- Next step: on approval → Gate 3, tests first in `scripts/release-desktop.test.mjs`. In parallel the owner does the 🔑 prerequisites (Developer ID Application cert into the login keychain + `xcrun notarytool store-credentials "snug"`), without which steps 4+ cannot run.
- Open questions: (1) the Apple **Team ID** for the signing identity string; (2) is there a backup of `~/.tauri/snug-updater.key`? — single-custody, no escrow (ADR-0047 §4), and the first release makes losing it consequential.

### 2026-08-24 23:25 — Jeetu — session (owner 🔑 prerequisites CLEARED)
- Done: **the signing blocker is gone.** Developer ID Application cert created via the **web-portal CSR route** (Xcode's Manage Certificates path did not work for the owner): openssl-generated CSR → developer.apple.com → `developerID_application.cer`. Identity is `Developer ID Application: Jitendra Maker (2KC5X47563)` (Team **2KC5X47563**, G2 CA, valid to 2031-08-26). Notarytool keychain profile `snug` created by the owner and **verified live against Apple** (`notarytool history` → "No submission history", i.e. authenticated).
- **Surprise worth keeping (→ lessons):** after `security import` the identity still listed as **0 valid identities**. Cause: the **Developer ID G2 intermediate CA was absent** from the login keychain, so the chain could not build. Xcode's flow installs intermediates implicitly; the web-portal route does NOT. Fix: import `DeveloperIDG2CA.cer` + `AppleRootCA-G2.cer` from apple.com/certificateauthority. Verified by an actual `codesign --options runtime --timestamp` smoke test — full chain to Apple Root CA, `flags=0x10000(runtime)`, trusted timestamp, and **no interactive keychain prompt** (so an unattended build will not hang).
- **Security housekeeping:** `~/.tauri/` was `drwxr-xr-x` and the private updater key `-rw-r--r--` (world-readable) → tightened to `700`/`600`. Key backup staged at `~/Desktop/snug-updater-key-backup-20260824/` with a README stating the no-escrow stakes; **owner confirmed NO prior backup existed** — the first release would otherwise have shipped with a single unbacked-up custody point.
- State: every prerequisite for a signed+notarized build is now satisfied on this machine. Gate 2 plan approved implicitly by the owner directing execution; Gate 3 begins.
- Next step: tests first in `scripts/release-desktop.test.mjs` for `checkUniversalArchs`, `appleSigningPlan`, `checkStapleOutput`, `checkSpctlOutput`.
- Open questions: **owner cleanup still owed** — move `~/Desktop/snug-updater-key-backup-20260824/` and the `.p12` in `~/Desktop/snug-csr/` into a password manager / encrypted volume, re-export the `.p12` with a real passphrase (it currently uses a throwaway one), then delete both Desktop folders.

### 2026-08-25 00:00 — Jeetu — session (build 1 FAILED; three assumptions disproved)

**Build 1 (`node scripts/release-desktop.mjs 0.1.0`) exited non-zero. Nothing was staged, nothing published.** It got as far as a signed universal DMG and then failed at updater signing. What it disproved, in order of severity:

1. **The keychain-profile decision does not work, and the design around it was wrong.** Tauri's bundler performs notarization *inside* `tauri build` and reads ONLY `APPLE_ID`+`APPLE_PASSWORD`+`APPLE_TEAM_ID` or `APPLE_API_KEY`+`APPLE_API_ISSUER`+`APPLE_API_KEY_PATH`. With `APPLE_KEYCHAIN_PROFILE` set it printed `Warn skipping app notarization` and carried on. The deeper error was mine: the plan notarized the **DMG** afterwards, but the bundler notarizes the **.app** before wrapping it — and the .app is what survives the drag to /Applications. Stapling only the DMG would have shipped an app that fails first launch offline. Owner decision 2026-08-25: **use the APPLE_ID trio** and let Tauri notarize. `appleSigningPlan` now refuses a keychain profile as insufficient, with the reason naming the real vars.
2. **A latent crash in the new lipo check**: the Mach-O is `Contents/MacOS/snug-desktop` (the CRATE name) while the bundle is `Snug.app` (productName). The hardcoded `.../MacOS/Snug` path does not exist. Now read from `CFBundleExecutable` in Info.plist, with a named refusal if it is absent.
3. **The updater tarball would have shipped unstapled.** `tauri build` writes `Snug.app.tar.gz` from the pre-staple .app. Publishing it hands every auto-updating client a bundle carrying no ticket — the exact offline-launch failure stapling prevents, delivered through the UPDATE path instead of the download path. The script now rebuilds the tarball from the stapled app and re-signs it.

**The updater signing key was unusable and has been replaced.** `~/.tauri/snug-updater.key` (generated 2026-08-21) decoded as `rsign encrypted secret key` — passphrase-protected, passphrase not recorded (owner confirmed). It could not sign, which is what actually killed build 1. Regenerated with **no passphrase** (unattended builds must not hang); new public key **F3922E7DDE0069B6** written to `tauri.conf.json` and verified byte-equal to the file on disk; signing proven through the script's own invocation form. **This was free ONLY because no release has ever shipped** — no installed client had trusted the old key. Post-launch the same mistake is unrecoverable. Old files deleted (owner decision) after the new key was proven.

**Verification posture (owner decision 2026-08-25):** the owner walks the DMG on real glass BEFORE `gh release create` — mount, read the Agree screen, drag to /Applications, confirm a plain double-click opens it. Script-side checks (staple validate, spctl accepted + `source=Notarized Developer ID`, lipo both-arch, SLA resource) are necessary, not sufficient.

- State: fixes committed (`4783133`); 16/16 script tests and 186/186 desktop tests green; env verified (identity valid, pubkey matches, signer works). **Build 2 is being run by the owner** with the APPLE_ID trio exported.
- Next step: on a green build — verify the staged `release-out/`, hand the DMG to the owner for the walk, then (and only then) `gh release create` on an explicit go-ahead.
- Open questions: owner still to move `~/Desktop/snug-updater-key-backup-20260824/` (now the NEW key) and `~/Desktop/snug-csr/` (the .p12, currently a throwaway passphrase) into a password manager / encrypted volume, then delete both Desktop folders.

### 2026-08-25 00:45 — Jeetu — session (build 2: signed + notarized + stapled; ALL script-side checks green)

**The artifact exists and every automated check passes on the exact staged bytes.** Two Apple submissions, both `Accepted`: the .app as `Snug.zip` (`b570af03-d24b-4b80-9382-110743f503d6`, submitted by tauri's bundler) and the DMG (`6a1ae884-c4e2-40e1-8782-2cfe5c30b941`, submitted separately — see below).

Verified on `apps/desktop/release-out/`:
- **universal**: `lipo -archs` on `Contents/MacOS/snug-desktop` → `x86_64 arm64`
- **DMG**: stapled (`validate worked`) + `spctl -a -t install` → `accepted`, `source=Notarized Developer ID`
- **.app**: stapled + `spctl -a -t exec` → same
- **EULA survives stapling** → `verifyDmgCarriesEula` on the POST-staple dump = `{ok:true}`. **This closes review F9's unverified interaction**: notarizing+stapling does NOT destroy the SLA resource.
- **updater tarball**: extracted `Snug.app` from `Snug.app.tar.gz` is itself stapled + Gatekeeper-accepted (the build-1 defect proven fixed, not merely reasoned about)
- **signature**: `.sig` key id `S2aQDefS6S` == the pubkey in `tauri.conf.json` (`F3922E7DDE0069B6`)
- **latest.json**: both darwin keys byte-identical, one versioned URL
- DMG sha256 `da7819afe1404877e839ffcb5699f5962d51de7aeffb1d3e7a116b771c347aec`

**Two more design errors that only running the thing revealed** (both fixed in `b112915`):

1. **A notarization ticket is keyed to the hash of ONE FILE.** Tauri submits the .app as `Snug.zip`; the **DMG is a separate artifact and was never submitted**, so `stapler staple` on it failed with `CloudKit query ... failed due to "Record not found"`. The plan's assumption — that notarizing the app covers the disk image — was simply wrong. The script now submits the DMG on its own before stapling it. Both artifacts need it for different reasons: the DMG is what a human downloads, the .app is what survives the drag to /Applications.
2. **An UNSET `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not an empty one.** Tauri prompts for it; with no TTY the build dies `incorrect updater private key password: Device not configured (os error 6)` — and it dies AFTER the notarization round-trip, the slowest step. Now defaulted to `''` explicitly inside the script, so the key's real state (no passphrase) is what the signer is told regardless of the caller's env.

**Method note for the next release:** rather than re-run the whole pipeline after fix (2) — another ~15 min build plus a third Apple submission — the remaining steps were completed directly against the already-notarized artifacts, each verified individually. The script is now correct end-to-end for v0.1.1; that path has NOT itself been run start-to-finish, which is the honest state of `release-desktop.mjs` today.

- State: **`release-out/` staged and fully verified script-side. Nothing published.** Awaiting the owner's DMG walk (Agree screen legible on real glass + plain double-click opens the installed app, no right-click).
- Next step: on a clean walk → apply the staged Gatekeeper-copy removal + R-29 rewrite, run root `pnpm test` + `check-public-scrub` by hand (ADR-0057), then `gh release create` on an explicit go-ahead.
- Open questions: unchanged — the two Desktop folders (new updater key backup; the `.p12` under a throwaway passphrase) still need moving into a password manager, then deleting.

### 2026-08-25 07:50 UTC — Jeetu — session (PUBLISHED — the first signed Release)

**Owner walked the DMG on real hardware and confirmed all three steps**: the Agree screen renders and is legible, and the installed app **opens on a plain double-click — no right-click → Open**. That is the claim no suite can make, and every gated edit below waited on it.

**PUBLISH RECORD (PROCESS.md §Release & publish rules; ADR-0047 §13):**
- **What:** GitHub Release `v0.1.0` on `snugprotocol/snug` — "Snug desktop v0.1.0", not a draft, not a prerelease.
- **When:** 2026-08-25T07:50:36Z.
- **Target commit:** `98e154c6eae5763e50c218685816a7d52fd20c24` (branch `feat/TASK-20260824-first-signed-release`, pushed first so the tag resolves on the remote).
- **Assets (5):** `Snug.dmg` (18,001,956), `Snug.app.tar.gz` (17,965,190), `Snug.app.tar.gz.sig` (400), `latest.json` (1,181), `desktop-releases.json` (1,112) — all `state: uploaded`.
- **URL:** https://github.com/snugprotocol/snug/releases/tag/v0.1.0
- **Verification performed BEFORE publish:** universal `x86_64 arm64`; both artifacts notarized (`b570af03…` app, `6a1ae884…` DMG) + stapled; `spctl` `accepted`/`source=Notarized Developer ID` on both; EULA intact in the POST-staple DMG; updater tarball's extracted app itself stapled + accepted; `.sig` key id == `tauri.conf.json` pubkey `F3922E7DDE0069B6`; `latest.json` both darwin keys byte-identical. Root `pnpm test` exit 0 (25/25), playground 1639/1639, desktop 186/186, `check-public-scrub` OK (by hand, ADR-0057).
- **Verification performed AFTER publish:** re-downloaded `Snug.dmg` from the release — sha256 `da7819afe1404877e839ffcb5699f5962d51de7aeffb1d3e7a116b771c347aec`, **byte-identical** to the walked artifact — and the downloaded copy still validates its staple and is Gatekeeper-`accepted`. The distribution path itself is proven, not assumed.

Pre-flip the repo is private, so anonymous fetches of these URLs 404 — designed-for state (ADR-0047 §1/§9); the launch check is quiet about it and the Settings check names it.

- State: **released and verified.** Gatekeeper copy retired from both download surfaces, R-29 partially resolved (TOFU half retained), ADR-0047 §7 amended, two lessons recorded. PR open for review.
- Next step: merge the PR; then `/close-session`. The v0.1.0→v0.1.1 update walk (check → chip → sheet → update now → restart, incl. the single-instance lock race and helper reap) stays open in next-steps and needs a SECOND release, i.e. its own explicit ask.
- Open questions: owner still to move `~/Desktop/snug-updater-key-backup-20260824/` (the new key — no passphrase, so the file IS the secret) and `~/Desktop/snug-csr/` (`.p12` under a throwaway passphrase) into a password manager / encrypted volume, then delete both folders. **Now higher stakes than before: with v0.1.0 published, the updater key is load-bearing for every client that installs it.**
