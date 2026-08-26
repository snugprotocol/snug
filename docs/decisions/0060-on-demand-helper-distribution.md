# 0060 — Helpers are on-demand, separately released, version-pinned downloads

- **Status:** **draft** (proposed 2026-08-26, owner-directed: "release helpers separately on GitHub; download on demand into `~/Snug/helpers/` when an app needs one; spawn immediately; seamless")
- **Date:** 2026-08-26
- **Task:** TASK-20260826-helper-bundle-update-sheet
- **Amends:** ADR-0047 §12 (helper not distributed by the update channel) and threat-model delta R-e (helper skew residual)

## Context

The Telepath WhatsApp helper (`apps/whatsapp-sidecar`) is today a developer install
(`install:helper` → `~/Snug/helpers/whatsapp-sidecar/`, spawned by `sidecar.rs` via the
*system* `node`, refused below Node 20). A public DMG has no helper; a user who installs
Telepath hits a developer-facing refusal string ("build and install it with `pnpm …`").

Measured on 2026-08-26: the installed tree is 62 MB, of which 26 MB is `@img/*` — sharp,
an *optional* baileys dependency for media thumbnails. Minus sharp the tree gzips to
**5.6 MB**. The official Node 22 macOS binary is 116 MB, **35 MB gz**. The DMG is 18 MB.

Bundling into the `.app` was considered and rejected by the owner: it grows every user's
download for a feature only Telepath users need, and without a runtime it still depends
on a system Node that most Macs lack. Helpers will multiply (Telepath is the first).

## Decision

1. **A helper is its own release artifact.** Each helper ships as a GitHub release on
   `snugprotocol/snug` tagged `helper-<name>-v<semver>` and marked **pre-release** — GitHub's
   `releases/latest` resolves only non-prerelease releases, so the desktop updater's
   `latest.json` endpoint (ADR-0047 §6) is never shadowed by a helper release. The tag
   carries: `<name>-darwin-aarch64.tar.gz` + `.sig`, `<name>-darwin-x86_64.tar.gz` + `.sig`,
   and `helper.json` (name, version, per-arch asset name, sha256, byte size).
2. **The archive is self-contained: it ships its own Node.** Contents: the helper's built
   `dist/` at the root, a `package.json` (`type: module`), a production `node_modules`
   **without sharp**, and `bin/node` — the official Node.js binary for that arch, fetched
   at pack time from nodejs.org and verified against `SHASUMS256.txt`. ≈ 41 MB per arch
   download, paid only by users who install an app that needs the helper. The shell spawns
   `<helper>/bin/node` when present; the bare `node` preflight path survives **only** for a
   developer install (which has no `bin/node`).
3. **The shell pins the helper version it requires.** `sidecar.rs` carries a `REQUIRED_HELPERS`
   table (`name`, `version`, download base = the pinned tag URL). Downloading from the pinned
   tag — never from "latest" — means an updated shell always names exactly the helper it was
   tested with. This *closes* threat-model residual R-e (helper skew): a downloaded helper's
   `helper.json` stamp is compared to the pin; mismatch surfaces as "update the helper", not
   silent skew.
4. **A developer install wins if present** (owner choice). A tree without a `helper.json`
   stamp is a dev install: it is never overwritten by the downloader and never version-checked
   (the dev knows what they installed). Only stamped, downloaded trees are upgraded.
5. **One trust root.** Archives are minisign-signed with the **same** updater key
   (`F3922E7DDE0069B6`, ADR-0047 §4); the shell verifies with `minisign-verify` (already in
   the tree via the updater plugin, now a named direct dependency) against the pubkey in
   `tauri.conf.json`. sha256 from `helper.json` is belt beneath the signature. An unsigned or
   mis-signed archive is discarded before extraction; nothing under `~/Snug/helpers/` is
   touched until the archive has verified.
6. **Install is explicit, never automatic.** Fetching from GitHub is a phone-home (same class
   as the launch update check, ADR-0047 §9). The shell downloads only on a user click on a
   surface that names the size and the source. Once installed, the helper starts without
   further prompts (the existing autostart rule is unchanged).
7. **Extraction is defensive.** Stream to a temp file with a byte cap (2× the manifest size,
   hard ceiling 300 MB); redirects must stay `https:`; extract into `~/Snug/helpers/<name>.partial-<nonce>`
   refusing absolute paths, `..`, symlinks and hardlinks; then atomic rename over the previous
   tree while the helper is stopped. A crash mid-install leaves a `.partial-*` directory that
   the next attempt removes.
8. **The `linked_device` requirement kind is the trigger.** No manifest schema change: an app
   whose connection declares `kind: "linked_device"` needs the helper named by the well-known
   provider (`whatsapp` → `whatsapp-sidecar`). The hub's install step and the pairing wizard
   both check `sidecarCtl('status').installed` and offer the download in place.
9. **Release rules apply unchanged.** `scripts/release-helper.mjs` packs, signs, writes
   `helper.json`, prints the `gh release create --prerelease` line and **stops**; creating the
   release is an explicit human ask (PROCESS.md release rules, ADR-0047 §13).

## Consequences

- ADR-0047 §12 is superseded; the threat-model delta gains surface **S9 — the helper download**
  (pinned tag, one signing key, capped/defensive extraction, explicit consent) and retires R-e.
- The x86_64 archive cannot be run natively on the owner's arm64 machine; it is verified by
  running the x86_64 `bin/node` under Rosetta and recorded as a residual until an Intel walk.
- `install:helper` stays for developers; its README line and the release notes for v0.1.2 say
  the helper is now downloaded on demand.
- Node-version refusals disappear for downloaded helpers; the messages stay for dev installs.

## Alternatives considered

- **Bundle in the `.app`** (with or without Node): +10 MB or +50 MB for everyone; rejected by owner.
- **Node SEA / pkg single binary**: smaller, but baileys' native/wasm deps and ESM make SEA
  fragile today; revisit when helpers stabilise.
- **Download from `releases/latest`**: would collide with the desktop updater endpoint and
  re-open the skew residual. Rejected.
- **A second signing key for helpers**: more custody for no threat reduction; the updater key
  already governs code the shell executes.
