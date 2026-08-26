# 0060 — Helpers are on-demand, separately released, version-pinned downloads

- **Status:** **accepted** (2026-08-26; plan-review amendments folded in the same day; first helper release `helper-whatsapp-sidecar-v0.1.0` cut under this ADR). Proposed 2026-08-26, owner-directed: "release helpers separately on GitHub; download on demand into `~/Snug/helpers/` when an app needs one; spawn immediately; seamless")
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
3. **The shell pins the helper by CONTENT, not just by version.** `src-tauri/helpers.json`
   (written by `release-helper.mjs`, `include_str!`'d by `helper_install.rs`) carries `name`,
   `version`, `tag`, and **per-arch sha256 + compressed + unpacked sizes**; `check-helper-pin`
   and `release-desktop.mjs` fail if it drifts from the staged/published `helper.json`. Downloading from the pinned tag — never from
   "latest" — means an updated shell always names exactly the helper it was tested with, and
   the consent card can state the size **before** any network request. A downloaded tree's
   `helper.json` stamp is compared to the pin by **exact equality** (not semver order — a
   downgraded shell must not call a newer helper "outdated"); on mismatch the shell still
   **spawns** the installed helper and offers the update (pin = wanted, never a refusal), so a
   shell that ships before its helper release cannot brick existing users. Rollback/skew
   residual R-e is thereby narrowed to developer installs (below), not retired.
4. **A developer install wins if present** (owner choice). `install:helper` writes a stamp
   `helper.json { kind: "dev", version }`; the downloader never overwrites a `dev` tree and
   the shell only *warns* (status field) on a dev pin mismatch — never blocks. Downloaded
   trees (`kind: "downloaded"`) are upgraded on mismatch after the user's click.
5. **One trust root, content-bound.** Archives are minisign-signed with the **same** updater key
   (`F3922E7DDE0069B6`, ADR-0047 §4); the shell verifies with `minisign-verify` (already in
   the tree via the updater plugin, now a named direct dependency) against the pubkey in
   `tauri.conf.json`. Because a minisign signature binds bytes, not identity, the signature
   alone would let a compromised GitHub account substitute *any* artifact ever signed with the
   key (an older helper, even `Snug.app.tar.gz`); the **pinned sha256 in the shell** is what
   closes that — `helper.json`'s sums are display data. An unsigned, mis-signed or wrong-sha
   archive is discarded before extraction; nothing under `~/Snug/helpers/` is touched until
   both checks pass.
6. **Install is explicit, never automatic.** Fetching from GitHub is a phone-home (same class
   as the launch update check, ADR-0047 §9). The shell downloads only on a user click on a
   surface that names the size and the source. Once installed, the helper starts without
   further prompts (the existing autostart rule is unchanged).
7. **Extraction is defensive.** The downloader reuses the shell's rustls transport with
   `Policy::none()` and follows redirects **manually**: at most 5 hops, `https:` only, hosts
   limited to `github.com` and `objects.githubusercontent.com`. Streams to a temp file with a
   compressed cap (2× pinned size); extraction caps **inflated** bytes (4× pinned unpacked size,
   hard ceiling 1 GiB) and entry count, admits only regular files and directories (no symlinks,
   hardlinks, devices, fifos), refuses absolute paths and `..`, preserves `0755` on `bin/node`,
   and post-validates the shape (`index.js`, executable `bin/node`) before anything is swapped.
   The swap is **two renames** (`rename(2)` cannot replace a non-empty directory): the old tree
   moves to `<name>.old-<nonce>`, the `.partial-<nonce>` tree moves to `<name>`, then `.old-*` is
   removed; on start, a missing `<name>` with an `.old-*` beside it is restored. One install per
   helper is in flight at a time (Rust-side lock); a second trigger subscribes to the first.
   The helper is stopped for the swap and restarted after it. `helper_install` is a
   download-and-execute command reachable over IPC, so it gets its own C2 gate rows
   (`ipc-helper-install-refused` + main-frame twin), like the updater commands.
8. **Quarantine does not apply, and that is stated, not assumed.** Files written by the shell's
   own `std::fs` carry no `com.apple.quarantine` (Tauri does not set `LSFileQuarantineEnabled`),
   so Gatekeeper never assesses `bin/node`; the hardened runtime constrains the parent's dylib
   loading, not its children. The Node binary is in any case Developer-ID signed by the Node.js
   Foundation. If `LSFileQuarantineEnabled` is ever added to the shell, this breaks at launch.
9. **The `linked_device` requirement kind is the trigger.** No manifest schema change: an app
   whose connection declares `kind: "linked_device"` needs the helper named by the well-known
   provider (`whatsapp` → `whatsapp-sidecar`). The hub's install step and the pairing wizard
   both check `sidecarCtl('status').installed` and offer the download in place.
10. **Release rules apply unchanged, plus two refusals.** `scripts/release-helper.mjs` builds
   ONE arch-independent tree (pure JS once peers are omitted, so both archives share a
   resolution), packs per-arch with the pinned Node (`node-runtime.json`: version + sha256 per
   arch, committed — the live `SHASUMS256.txt` is never trusted; a Node CVE now implies a helper
   re-release), signs, writes `helper.json`, prints `gh release create --prerelease
   --latest=false` and **stops**. It refuses if the tag already exists (releases are immutable
   — the shell pins content). `release-desktop.mjs` refuses to stage a desktop release whose
   pinned helper tag is not published. Creating either release is an explicit human ask.

## Dependencies (docs/conventions.md: every new dependency is justified here)

Five crates become **direct** dependencies of the shell; all five already ride in the tree
through `tauri-plugin-updater`, so nothing new is compiled — they are named because this
crate now calls them, and a plugin upgrade that dropped one must fail at resolution, not with
a mystifying build error (the reqwest precedent in Cargo.toml):
- `minisign-verify` — verifies the archive signature against the updater pubkey (§5), streaming.
- `tar` + `flate2` — unpack the archive under the shell's own admission rules (§7); the
  alternative, shelling out to `/usr/bin/tar`, cannot refuse an entry *before* writing it.
- `webpki-roots` — a real root store for the GitHub download; the LAN client is deliberately
  built with no roots (custom pin verifier) and cannot be reused.
- `base64` — decodes the pubkey and `.sig` exactly as the updater plugin does.

## The pin file

`apps/desktop/src-tauri/helpers.json` is written by `scripts/release-helper.mjs` from the
staged manifest, `include_str!`'d by `helper_install.rs`, read by `check-helper-pin.mjs`
and by `release-desktop.mjs` — which also fetches the **published** `helper.json` for the
pinned tag and refuses to stage a shell unless the published sums equal the pin (a tag that
exists with different bytes would make every user's download refuse on the content pin).
Never edited by hand.

## Consequences

- ADR-0047 §12 is superseded; the threat-model delta gains surface **S9 — the helper download**
  (pinned tag, one signing key, capped/defensive extraction, explicit consent) and retires R-e.
- No uninstall surface ships in this task (~180 MB on disk per helper); recorded as a residual
  and a next-steps item. `.old-*`/`.partial-*` litter is reaped on the next install or start.
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
