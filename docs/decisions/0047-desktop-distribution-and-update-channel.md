# 0047 — Desktop distribution and the shell update channel

- **Status:** accepted (owner plan approval, 2026-08-21; every actual `gh release create` remains its own explicit per-session ask); **§7 amended 2026-08-24 — signing/notarization implemented for real; see [Amendment](#amendment--2026-08-24-signing-and-notarization-implemented-task-20260824-first-signed-release)** **§12 superseded 2026-08-26 by [ADR-0060](0060-on-demand-helper-distribution.md) (helpers download on demand) — see the amendment below.**
- **Date:** 2026-08-21
- **Task:** TASK-20260821-hardening-polish (P5)

## Context

The desktop shell (ADR-0021, macOS-only through 1.0 per D8) has never had a distribution or update story: no installer channel, no signing, no updater, and the version declared in three unsynced files (`apps/desktop/package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`). `docs/next-steps.md` has carried "installer/signing/notarization + download links" since 2026-08-12. Meanwhile ADR-0045 built the product's update-channel doctrine for starters — versioned releases, cumulative Tesla-style structured notes, **offered-not-auto-applied** — and ADR-0013 constrains the hosted hub to static files only.

The owner wants the ChatGPT/Claude-desktop shape: the web app offers the download; installed clients see new releases and choose to update, with release notes good enough to read on their own.

## Decision

1. **Distribution is GitHub Releases on `snugprotocol/snug`** (owner choice 2026-08-21). A release ships the DMG (human download), the `.app.tar.gz` + `.sig` updater artifacts, and `latest.json`. All static assets — ADR-0013-compatible. Pre-flip the repo is private, so anonymous fetches 404; that state is designed-for (see 9). The hosting choice is revisitable at launch without touching the client contract: everything keys on one URL constant.
2. **One endpoint constant, homed in the playground.** `apps/playground/src/releaseChannel.ts` owns the release endpoint + download URLs; the download page imports it, and a desktop-side test **byte-compares** it against `tauri.conf.json`'s `plugins.updater.endpoints` (config JSON cannot import TS — the compare pins the two spellings, lessons 2026-07-31). Dependency direction stays desktop→playground (the `@playground` alias); the playground never imports from `apps/desktop`.
3. **The updater is `tauri-plugin-updater` + `tauri-plugin-process`, strictly opt-in.** ADR-0045's rejection of auto-apply is inherited: the shell checks, then *offers*; nothing installs without the user's click, and "later" is always available. `bundle.createUpdaterArtifacts: true`; permissions land in the main-window capability, and the C2 gate gains **per-command negative rows** (`plugin:updater|check`, `plugin:updater|download_and_install`, `plugin:process|relaunch` keyless-refused from a sandboxed srcdoc iframe) beside a positive main-frame twin — capability placement alone proves nothing about iframes (gate/ipc.ts amendment-16 doctrine).
4. **Update artifacts are minisign-signed; the key custody is the owner's.** Keypair generated once via `tauri signer generate` into `~/.tauri/` (never in the repo, never in CI); `TAURI_SIGNING_PRIVATE_KEY`(+`_PASSWORD`) exported only in the owner's build shell. The public key is committed in `tauri.conf.json`. Losing the private key orphans every installed client's update path (they can still download manually) — recorded as the cost of no key-escrow.
5. **The trust split is stated, not implied: the signature covers the ARTIFACT only.** `latest.json`'s `version`, `notes`, `pub_date`, and `url` fields are trusted on TLS-to-GitHub alone. A compromised GitHub account therefore cannot install a binary (signature fails) but CAN lie in the update *prompt*. Consequently: fetched fields are untrusted display data — version syntax-validated, notes rendered as plain text with no actionable links, and the update sheet's canonical structured notes come from the release's `releases.json` asset under the same plain-text rules. The threat-model delta names what a GH compromise can and cannot do.
6. **Universal macOS binary**: `tauri build --target universal-apple-darwin`; both `darwin-aarch64` and `darwin-x86_64` platform keys in `latest.json` point at the one artifact. (Fallback if the universal build proves troublesome: aarch64-only with an honest single-key `latest.json` — not preferred.) Requires `rustup target add x86_64-apple-darwin aarch64-apple-darwin`.
7. **Apple code-signing + notarization are wired but env-gated** (owner is obtaining a Developer ID): when `APPLE_SIGNING_IDENTITY`/notarization vars are present the release script signs and notarizes; absent, it builds unsigned, WARNS loudly, and the download page carries the honest Gatekeeper disclosure (right-click → Open). The minisign updater signature is independent of Apple signing and always applies.
8. **One version, three files, one script.** `scripts/release-desktop.mjs` (repo root wiring: `check-release-desktop` in root `package.json`, run by `pnpm test`) bumps `package.json`/`tauri.conf.json`/`Cargo.toml` together, refuses without a matching `releases.json` entry (ADR-0045's sections/items shape with a **semver** `version` — the integer rule is starters-only), runs `gate:release`, builds, emits `latest.json`, and PRINTS the `gh release create` command without running it. A test pins the three-way version equality.
9. **The shell checks on launch (toggleable) and on demand.** Launch check is ON by default with a Settings toggle ("check for updates automatically") — the check is a phone-home (GitHub learns IP/version/launch time) and the threat-model delta names it. A failed launch check is silent by design (pre-flip 404 is the normal state); the Settings "check for updates" button reports failure by name. The offer surface is a non-blocking chip, never a gate in front of the hub (lessons 2026-08-20: prominence that blocks is a modal with extra steps).
10. **Update flow reaps before it relaunches.** Verdict from the Tauri source/docs, recorded here: `AppHandle::restart()` — which `plugin-process`'s `relaunch()` rides — explicitly *skips* `RunEvent::ExitRequested`/`Exit` delivery when invoked on the main thread, so the shell's exit-time sidecar reap CANNOT be assumed to run. The flow is therefore `downloadAndInstall` → explicit sidecar reap (the existing TERM-first shutdown + pidfile removal) → `relaunch()`. The real relaunch (single-instance lock race included) is on the owner manual-test list — no suite can perform it.
11. **Pre-flip testing uses a dev-only `--config` overlay, not code.** `apps/desktop/updater-dev.json` points the updater at a local static stub (`tauri dev --config updater-dev.json`; a deliberate test bundle the same way). No override code path exists in the shell at all — nothing to env-gate, nothing to leak. The enforcement is a **MUST-APPEAR** check in `run-release-gate.mjs`: the release binary must contain the production endpoint byte-for-byte, which fails both "endpoint dropped from config" and "release accidentally built with the overlay" through one self-controlling mechanism. No GitHub token ever rides in the shell — the header-token idea is rejected outright (github.com asset downloads don't header-auth, and a PAT in the updater transport is a credential path with a redirect-forwarding failure class, lessons 2026-08-12).
12. **The WhatsApp helper is NOT distributed or updated by this channel** — it remains a repo-installed artifact (`install:helper`), so a publicly-downloaded shell has no Telepath helper and an updated shell may drive an older helper. Disclosed residual in the threat-model delta; the spawner version-stamp check stays the filed next-steps fix.
13. **Release rules grow one line** (PROCESS.md §Release & publish rules + the root-file mirrors): creating or editing a GitHub Release on snugprotocol repos requires an explicit human ask in that session and a journal record — the standing list predates the repo having anything binary to publish.

## Alternatives considered

- **Cloudflare R2/Pages hosting now** — viable and ADR-0013-aligned; deferred by owner choice (GitHub Releases needs zero new infrastructure pre-launch). The single-homed constant keeps the switch a one-line change + re-release.
- **Auto-apply updates** — rejected; ADR-0045 already litigated it ("silently swapping running code is its own hazard"), and a shell binary raises the stakes, not lowers them.
- **Sparkle** — rejected; the Tauri-native updater shares the bundle pipeline, the capability model, and the C2 gate surface the repo already tests.
- **Per-app-store distribution (Mac App Store)** — out of scope pre-1.0; sandboxing model conflicts with the shell's file/socket surface, revisit post-launch if ever.

## Consequences

- The web hub gains `/download` (macOS-only copy, honest signing state, structured notes); Settings gains version + update controls on desktop and a download pointer on web.
- Threat model v2 gains the desktop-update-channel delta: key custody, artifact-vs-manifest trust split, the launch-check phone-home, the TOFU first download, the helper skew residual.
- `bundleTargets.test.ts` keeps ADR-0021 D8 pinned (macOS targets only); updater config gets its own sibling test.
- First actual release (v0.1.0) happens only on a fresh explicit ask, journaled per PROCESS.md.

## Amendment — 2026-08-24: signing and notarization implemented (TASK-20260824-first-signed-release)

**§7 described a mechanism that did not exist.** It said signing and notarization were "wired but env-gated: when `APPLE_SIGNING_IDENTITY`/notarization vars are present the release script signs and notarizes". In fact `release-desktop.mjs` read `APPLE_SIGNING_IDENTITY` exactly once, as a boolean, to decide whether to print a warning. There was no notarization call, no stapling, no hardened runtime, no entitlements file, and no `bundle.macOS` block. The env-gate was real; the thing it gated was not. Recorded plainly because the gap was invisible from the ADR alone — the prose read as shipped.

What now exists, in the order the script runs it:

1. **`appleSigningPlan(env)` replaces the boolean.** Three outcomes, not two: `signed` (identity + notary profile), `unsigned` (neither — a cert-less machine must still be able to build), and **`refused`** for the half-configured middle. Half-configured was the dangerous state: an identity without notary credentials produces a signed-but-un-notarized DMG that Gatekeeper still blocks, discovered only after the slowest step in the pipeline. An identity that is not a `Developer ID Application:` cert is also refused up front — `Apple Development` certs sign happily and fail notarization at the far end.
2. **Notarize → staple → verify.** `notarytool submit --wait`, then `stapler staple`, then `checkStapleOutput` over `stapler validate` and `checkSpctlOutput` over `spctl -a -vvv -t install`. The Gatekeeper check demands **both** `accepted` and `source=Notarized Developer ID`: an artifact can be accepted for unrelated reasons, and matching "accepted" alone would vouch for a notarization that never happened. Stapling is checked separately because notarizing without stapling is the classic silent failure — it works on the build machine and fails for a user who is offline at first launch.
3. **The EULA check moved AFTER stapling.** Stapling rewrites the DMG. Verifying the SLA resource before it proved a property of bytes that no longer ship. Review F9 flagged this interaction as unverified; it is now verified in the only order that means anything.
4. **`checkUniversalArchs` gates §6's universal claim.** `lipo -archs` on the Mach-O inside the `.app` must report **both** `arm64` and `x86_64`, matched as exact tokens (`arm64e` is the pointer-authentication ABI, not a distribution architecture, and a substring test passes on it). §6 pointed both `latest.json` platform keys at one artifact without ever checking the artifact was fat — which made a thin build silently wrong rather than loudly broken.

**Credential mechanism: notarytool keychain profile** (owner decision 2026-08-24). `xcrun notarytool store-credentials` stores the Apple ID + app-specific password in the keychain; the build refers to it only as `APPLE_KEYCHAIN_PROFILE=snug`. No app-specific password in the environment, in shell history, or in any file. Cost: the profile is machine-local, so a future CI signer needs a different mechanism (an App Store Connect API key) — acceptable, since §4 already forbids keys in CI.

> **Superseded the same day — see [the 2026-08-24 §7 credential amendment](#amendment--2026-08-24-credential-mechanism-corrected-keychain-profile-does-not-work) below.** The paragraph above records the decision as taken; the mechanism it names does not work, and the code has never implemented it.

**Entitlements are minimal and deliberately so.** `apps/desktop/src-tauri/entitlements.plist` grants `allow-jit` and `allow-unsigned-executable-memory` — the documented WKWebView pair, required because notarization mandates the hardened runtime and the hardened runtime blocks JavaScriptCore's JIT. Nothing else. `disable-library-validation` is absent (the WhatsApp helper is a separate process, not a library, so it does not need it); `allow-dyld-environment-variables` is absent (an injection vector). **Entitlements govern the shell process, not the app iframe** — C1 and C2 are enforced by the CSP, the `sandbox="allow-scripts"` attribute and the capability allowlist, none of which this file can weaken.

**Consequence for §7's last sentence:** it still holds — the minisign updater signature is independent of Apple signing and always applies.

## Amendment — 2026-08-24: credential mechanism corrected (keychain profile does not work)

**The keychain-profile decision recorded above was superseded within the same task, and the paragraph stating it was never updated.** It stood for two days and through two releases reading as current.

`xcrun notarytool` accepts `--keychain-profile`, so the mechanism is sound *for notarizing a file by hand*. But **Tauri's bundler notarizes the `.app` mid-build and never reads a keychain profile** — it looks only for `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH`, and skips notarization with a warning when neither trio is present. Notarizing only the DMG afterwards leaves the `.app` the user actually runs un-notarized once it is copied to /Applications, which is the failure the 2026-08-25 lessons entry describes.

So the app-specific password **must** be in the build environment. That is a real cost, and the earlier decision was taken specifically to avoid it; it is paid because the alternative is an un-notarized app, not because the privacy goal was wrong. The mitigations are:

- `appleSigningPlan` **refuses** a keychain profile presented alone rather than accepting it as configured — `release-desktop.test.mjs` pins that refusal, with the reason naming this amendment. The code has always behaved this way; only the prose was stale.
- The owner exports the trio with a leading space (`histignorespace`) for the one command, from 1Password. Nothing is written to a file, and §4's ban on keys in CI is unaffected — this is a local-only, per-release export.
- The App Store Connect API-key trio remains the better long-term answer and is already supported; it is the path a future CI signer would take.

**General shape, recorded because this is the second time in this ADR:** a credential mechanism is only decided once the tool that consumes it has been checked — `--help` on the CLI you will actually invoke, not the one you would invoke by hand. The 2026-08-26 lessons entry on the updater key's two spellings is the same class one variable over.

## Amendment — 2026-08-26: §12 superseded by ADR-0060 (helpers download on demand)

§12 said the WhatsApp helper is not distributed by this channel and stays a developer
install. **ADR-0060** replaces that: helpers are separately released GitHub **pre-releases**
(`helper-<name>-v<semver>`, so `releases/latest` — this ADR's §6 endpoint — is never
shadowed), signed with the SAME minisign key as §4, and **pinned by content** in the shell
(`helper_install.rs` `REQUIRED_HELPERS`: tag + per-arch sha256/sizes). The shell downloads
one only on a user click and only from its pinned tag. The threat-model delta's R-e is
narrowed to developer installs; surface S9 (the helper download) is added. `install:helper`
remains for developers and now writes a `kind: "dev"` stamp the downloader never overwrites.
