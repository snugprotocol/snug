# TASK-20260824-first-signed-release: First signed + notarized macOS Release (universal)

- **Status**: in-progress (Gate 3 — tests first)
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
