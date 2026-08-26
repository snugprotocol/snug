# Threat-model delta — desktop distribution and the shell update channel

- **Task:** TASK-20260821-hardening-polish (P5) · **ADR:** [0047](../decisions/0047-desktop-distribution-and-update-channel.md)
- **Date:** 2026-08-21
- **Scope:** what publicly distributing the macOS shell and giving it a self-update
  channel adds to the attack surface, and what is **accepted and not mitigated**.

> **How to read this.** A *delta*. It assumes the desktop-shell delta (the Tauri
> process boundary, IPC capability scoping, the invoke-key gate) and inherits ADR-0045's
> offered-not-auto-applied doctrine. This is the repo's **first supply-chain surface**:
> until now nothing the product shipped could replace the product.

---

## 1. The posture change in one sentence

The shell can **download and install a new copy of itself**, which makes an update
manifest on a third-party host (GitHub) part of the trusted computing base — bounded, at
the point where it matters most, by a minisign signature over the artifact that the
publishing account cannot forge.

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **Binary installation as the user** — `plugin:updater\|download_and_install` exists in the shell for the first time | Reach it from a sandboxed app iframe and replace the shell with attacker bytes — strictly worse than reaching `sidecar_fetch` | Capabilities are per-WINDOW, so placement alone proves nothing about iframes; the C2 gate gained **per-command** keyless-refusal rows (`ipc-updater-check-refused`, `ipc-updater-install-refused`, `ipc-process-relaunch-refused`) driving real well-formed invokes from a sandboxed srcdoc frame, paired with a positive twin proving the main window CAN dispatch (a refusal check over an unregistered command vouches for nothing). |
| **S2** | **The downloaded artifact** | Serve a malicious `.app.tar.gz` from a compromised release, a MITM'd CDN, or a substituted asset URL | Every updater artifact is **minisign-signed** and verified in Rust before install. The private key never enters the repo or CI (custody: the owner's `~/.tauri`), so an attacker who takes the GitHub account still cannot produce an installable artifact. |
| **S3** | **`latest.json` — the manifest** | Control what the user is told: a fake "critical security update", attacker prose in the notes, a poisoned asset URL that makes updates fail toward a manual download | **Signature covers the ARTIFACT, not the manifest** (§3 R-a). Compensating controls: the version string is syntax-validated; fetched notes render as **plain text with no linkification** (pinned by test); the sheet's structured notes prefer the release's own notes asset under the same plain-text rules; and no update copy ever asks the user to go elsewhere or type anything. |
| **S4** | **The endpoint the client trusts** | Point a shipped build at an attacker's manifest host by editing config, or by shipping a build made with the dev overlay | The endpoint is single-homed in `apps/playground/src/desktop/releaseChannel.ts` and **byte-compared** against `tauri.conf.json` by test (config JSON cannot import TS). The dev overlay is a `--config` file with no code path in the shell at all, and `run-release-gate.mjs` gained a **MUST-APPEAR** check: a release binary that does not contain the production endpoint byte-for-byte fails the gate — one mechanism covering both "endpoint dropped" and "built with the overlay". |
| **S5** | **The relaunch** — the shell's first programmatic restart | Orphan the WhatsApp helper across the restart, so the next launch's rival wedges the linked-device session in a permanent conflict loop | `AppHandle::restart()` **skips** `RunEvent::ExitRequested`/`Exit` delivery when called on the main thread, so the exit-time reap cannot be assumed. The platform seat therefore reaps explicitly (`sidecar_ctl('stop')`) **before** relaunching, pinned by a call-order spy rather than a comment. |
| **S6** | **The launch-time update check** — an automatic outbound request on every desktop launch | — (this is a privacy surface, not an integrity one; see R-c) | Toggleable in Settings (`snug:auto-update-check`); only the literal string `'false'` disables, so a corrupted key fails toward the feature. Quiet on failure by design. |
| **S7** | **The download page** — a public first-acquisition path | Serve a malicious DMG from a lookalike page; or exploit the unsigned state to normalise Gatekeeper bypass | The page links only to the single-homed GitHub Releases asset URL. The unsigned state is DISCLOSED on the page rather than smoothed over (R-b) — teaching a right-click-Open habit is a real cost, and the honest fix is Apple signing, which is wired and env-gated. |
| **S8** | **The release pipeline** (`scripts/release-desktop.mjs`) | Publish a version whose notes describe something else; publish without the release gate; publish accidentally | It refuses without a matching newest `desktop-releases.json` entry, runs `gate:release`, refuses without a signing key, and **never publishes** — it prints the `gh release create` command and stops. Creating a GitHub Release now requires an explicit human ask in that session (PROCESS.md release rules + the root-file mirrors). |
| **S9** | **The helper download** (ADR-0060; `helper_install.rs`) — the first path by which the shell fetches and EXECUTES code other than itself | Serve a substituted archive (any artifact ever signed with the updater key, an older helper with a known bug), a gzip bomb, a tar with `..`/symlink entries, a redirect off GitHub; trigger a download the user never asked for from an app iframe | **Content pin**: the shell carries the tag + per-arch sha256 + sizes; a valid signature over the wrong bytes is refused (`a_valid_signature_over_the_wrong_artifact_is_refused_by_the_content_pin`). Signature verified with the updater pubkey read from `tauri.conf.json` (one trust root). Manual redirects: ≤5 hops, `https:` only, hosts ∈ {github.com, objects.githubusercontent.com, release-assets.githubusercontent.com}. Compressed cap 2× pin, **inflated** cap 4× pin (≤1 GiB), ≤50k entries, regular files + dirs only, no absolute/`..` paths, unpack via `unpack_in`. Two-rename swap with `.old-*` restore. Explicit click only (§6); `ipc-helper-install-refused` + `ipc-helper-status-dispatchable` in the C2 gate. Helper releases are pre-releases so `releases/latest` (S3/S4) is untouched. `release-desktop.mjs` refuses a shell whose pinned helper tag is unpublished. | A compromised nodejs.org at PACK time is bounded by the committed `node-runtime.json` sha256 pin (a reviewed diff); the bundled Node is Developer-ID signed by the Node.js Foundation; quarantine does not apply to files the shell writes itself (Tauri sets no `LSFileQuarantineEnabled`) — **stated, so that adding it is known to break helper launch**. No uninstall surface yet (~140 MB on disk). |

## 3. Residual risk — accepted and NOT mitigated

### R-a — The signature covers the artifact; the PROMPT is TLS-trusted only
This is the sharpest residual here and it deserves the plain statement: an attacker who
compromises the publishing GitHub account **cannot install a binary** (S2 holds) but
**can fully control what the update dialog says** — version number, dates, and notes
prose. The realistic attack is therefore social: a fabricated "critical update" whose
notes steer the user somewhere the signature does not reach. The compensating controls
in S3 bound the shape of that message (plain text, no links, no instructions), and the
UX deliberately gives the attacker no button to aim. Manifest signing would close it;
the current channel does not have it.

### R-b — Builds are UNSIGNED and un-notarized until the Developer ID lands
First-run requires a right-click → Open, which is precisely the habit that makes users
vulnerable to other unsigned software. Disclosed on the download page rather than
hidden, and the signing path is wired and env-gated so it activates the day credentials
exist. Until then, a user who acquires a tampered DMG from anywhere but the linked
release URL gets no OS-level warning that would distinguish it from ours.

### R-c — The launch check is a phone-home
Every launch (with auto-check on, the default) tells github.com the user's IP, the time,
and the running version. Snug's posture is "we collect nothing as architecture", and
this is the first automatic outbound request the desktop app makes that is not the
user's own work. It is disclosed in Settings copy, toggleable, and goes to a third party
we do not control rather than to us — but a user who wants zero background traffic must
turn it off, and that is a choice they should not have to discover.

### R-d — First download is TOFU with no out-of-band verification
Nothing published today lets a user verify the DMG independently (no checksums page, no
signing identity to check while unsigned). The whole first acquisition rests on TLS to
github.com and on the user having reached the right link.

### R-e — Helper skew, NARROWED to developer installs (ADR-0060, 2026-08-26)
Public users now get the helper from the on-demand download, pinned by content to the
shell that drives it, so shell/helper skew for them is detected (`mismatch`) and offered
as an update — never refused, so a shell shipped ahead of its helper release cannot brick
anyone. What remains: a **developer install** (`install:helper`, `kind: "dev"` stamp, or a
stampless legacy tree) is never overwritten by design and only *reported* as mismatched.
The owner's own machine is exactly this case; the hardware walks it hosts are unchecked
for skew unless the dev tree is rebuilt. Also unmitigated: no uninstall surface, and the
x86_64 archive is verified only under Rosetta until an Intel walk.

### R-f — Losing the minisign private key orphans the update path
No escrow. Every installed client verifies against the pinned public key, so a lost
private key means no further updates can be issued to existing installs (manual
re-download still works). Accepted as the cost of not putting a signing key anywhere a
CI compromise could reach.

### R-g — The relaunch's single-instance race is unproven by any suite
S5's reap ordering is tested; what no test can perform is the real restart, including
whether the new instance can take the single-instance lock the old one is releasing.
That verification is on the owner's manual-test list, and the failure mode it guards
against is user-visible ("I clicked update and the app just quit"), not silent.
