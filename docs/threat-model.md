# Snug — Threat Model

- **Version:** 3.0 · **Date:** 2026-08-21 · **Tasks:** TASK-20260820-threat-model-v1 (v1) · TASK-20260821-hardening-polish (v2) · TASK-20260821-launch-security-review (v3)
- **Status:** current as of commit-time. This document is audited, not transcribed — every
  enforcement claim below was checked against the code by an adversarial pass that tried to
  break it, and defects those passes found were fixed before each version was written.
- **What v3 changed — the pre-launch pass, and the reason it exists.** v2 stated its own
  limit: its adversarial pass was targeted at four new surfaces, and "the rest of this
  document is v1's, re-checked mechanically but not re-attacked." A launch review that
  inherited that boundary would ship v1's audit as though it were current. v3 therefore
  **re-attacked the whole surface** across seven parallel fresh-context lanes — C1, C2 and
  the desktop IPC census, the net executor's ten gates, prompt injection and LLM egress,
  spec-vs-code conformance, flip-public hygiene, and the reference server plus storage
  custody (the last had **never been assigned a reviewer** in v1 or v2).

  Three defects were **fixed rather than described**: a credential leak in the OAuth error
  seat (the scrub covered only the decoded spelling of a submitted secret, while a provider
  echoing the bytes it received returns the percent-encoded one — see §5's C1 row and the
  §9 record), a false claim in R-8 (the confirm dialog did not render the URL it was
  documented to name), and R-12's missing per-command IPC row. Two numbers that were simply
  wrong were corrected: §1 said "eight deltas" against a twelve-row ledger, and R-12's
  command census was stale in both its numerator and its denominator.

  **What v3 did NOT do** is in §9, stated as plainly as what it did.
- **Reporting:** [SECURITY.md](../SECURITY.md) · **security@snugprotocol.org**

---

## How to read this

Snug's security claims are meant to be falsifiable, so this document is organised to make
falsifying them cheap. Two rules govern it:

**A promise with no named enforcement point is not an invariant.** §5 gives every enforced
invariant a file that enforces it and a test that fails if it regresses. Anything that could
not carry both was moved to §6 — the residuals — rather than being softened into a sentence
that sounds reassuring and commits to nothing.

**§6 has equal standing with §5.** A threat model that lists only wins reads as marketing.
The residuals are the part a reviewer deciding whether to trust this system should read
first, and several of them are sharp. Two are known defects on a platform we therefore do
not ship.

If you are evaluating whether to rely on Snug, read §2 (what is actually protected), then
§6 (what is not).

---

## 1. Scope

**In scope: the reference implementation in this repository** — the protocol bindings, the
iframe runner, the SDK, the per-app database, the connected-fetch executor, the credential
store, the Playground, the reference server, and the macOS desktop shell.

**The shipped desktop surface is macOS only, through alpha, beta and 1.0.** This is not a
roadmap gap; it is a security decision recorded in
[ADR-0021 D8's addendum](decisions/0021-desktop-shell-transports.md). Windows is a platform
on which C2 is *known to be false* — see R-5 in §6 — so no release in that window ships a
Windows desktop build. Windows desktop is reconsidered **post-1.0**, as its own decision.
We would rather a Windows user learn that here than from an install that quietly breaks the
sandbox.

**Out of scope:** vulnerabilities in LLM providers, browsers, or OS/WebView internals
(reported upstream; mitigated where we can); a user deliberately exporting with secrets
included, or pasting their own key into an unrelated malicious site; secrets present in a
personal sync origin the user connected — that is [ADR-0014](decisions/0014-credentials-local-first.md)
custody working as designed; denial of service against the user's own browser tab or own
self-hosted server; and third-party self-hosted infrastructure misconfiguration.

**This document consolidates twelve per-change threat-model deltas** (§8). A delta is written
for someone who already knows the system and is reading one change; this is written for a
stranger deciding whether to trust the whole thing. Where a delta's residual is restated
here it is marked as inherited, because a model that re-sells an old residual as new is as
misleading as one that hides it.

---

## 2. Assets

What an attacker would actually want, in rough order of severity:

| Asset | Where it lives | What its loss means |
|---|---|---|
| **Credentials** — API keys, OAuth access/refresh tokens, client secrets, signing keys, minted helper tokens | `snug_secrets` in the user's own SQLite file, under the `auth:` namespace | Access to the user's connected accounts. The severity anchor for C1. |
| **The user's app data** | Per-app SQLite namespaces in the same file | Personal records: finances, messages, journals. |
| **Other people's messages** | The WhatsApp helper's own store, and thread content reaching an LLM | Third parties who never consented and cannot opt out. See §6 R-9. |
| **The user file itself** (`~/Snug/user.snug`) | On disk. Plaintext by default; **AES-256-GCM ciphertext when the user turns protection on** ([ADR-0043](decisions/0043-passphrase-encryption-at-rest.md)) | Everything above at once — unless protected, in which case an attacker holding the file holds ciphertext and must guess a passphrase offline. |
| **The host page's execution context** | The browser tab / the shell's main window | Total compromise — it holds every credential and calls fetch. See §6 R-1. |
| **The user's attention at a consent gate** | The wizard's review screen; the confirm dialog | The last wall behind several accepted residuals. If review copy degrades, those trades stop paying. |

---

## 3. Adversaries

| # | Adversary | Capability assumed | Primary defence |
|---|---|---|---|
| **A1** | **A hostile micro app** — LLM-authored or user-installed, running in the iframe | Arbitrary JavaScript, including `eval`; full control of its own document | C2: opaque origin, `connect-src 'none'`, no IPC reach |
| **A2** | **A hostile or compromised provider** on a host the user approved | Chooses every response byte; may echo submitted parameters; may run a debug/echo endpoint | Frozen host ceiling; response scrub; bounded error extraction |
| **A3** | **A prompt injector** — text arriving via provider bodies, app rows, or other people's WhatsApp messages | Writes text the model reads as though it were instruction | Fenced untrusted blocks; confirm gate on every mutating call; lane asymmetry (§6 R-7) |
| **A4** | **A hostile connection requirement** — authored by an LLM steered by A3 | Proposes provider name, hosts, field labels, header templates | Admission's borrow ban; template lint; verbatim human review |
| **A5** | **A hostile file** — an import, a `.snug` double-click, a sync image from an untrusted donor | Chooses every byte of a user database | Import demotes to `declared`; contract reconciliation; single-use open allowlist |
| **A6** | **A local process** running as the same user | Reads any file the user can read | **Unprotected file: not defended** — the OS user account is the perimeter. **Protected file: whole-file AES-256-GCM**, so the bytes are ciphertext at rest. Neither case defends a running host page that has already unlocked. See §6 R-3. |
| **A7** | **A LAN-local attacker**, present at first device pairing | Answers at the typed address before the real bridge | TOFU pin; physical button press. Residual R-6. |

**Deliberately not an adversary: the hub.** [ADR-0013](decisions/0013-hosted-hub-static-zero-backend.md)
removes the backend and [ADR-0014](decisions/0014-credentials-local-first.md) puts custody
in the user's file, so there is no server-side vault to compromise. The honest claim, and
the only one made anywhere: **"your keys never reach our servers; your file, including keys,
goes only to storage you choose."** Never the absolute "keys never leave your file" — a
personal Dropbox the user connects legitimately carries them.

---

## 4. Trust boundaries

Five boundaries. Everything security-relevant happens at one of them.

1. **App iframe ↔ host page.** The strongest boundary. The app has an opaque origin, no
   network of its own, and no capability it was not handed. Crossings are `postMessage`
   frames, zod-validated at the envelope boundary, routed by `contentWindow` identity
   (never `event.origin` — a sandboxed frame's origin is the string `"null"` and would
   accept *any* sandboxed frame on the page).
2. **Host page ↔ provider network.** One seat: the connected-fetch executor and its ten
   gates. It is the only host-side caller that both reads a credential and calls fetch.
3. **Host page ↔ LLM.** What reaches a model is assembled host-side; credentials never do.
   Untrusted content that must reach it is fenced and the instruction restated after.
4. **Webview ↔ native shell** (desktop only). The Tauri IPC bridge, which CSP does not
   govern. Capabilities are main-window-scoped and the invoke key is absent in subframes —
   *on macOS*. On Windows it is not, which is why Windows does not ship.
5. **The user's device ↔ everywhere else.** The custody line. Hub origins never receive
   secrets; personal sync origins carry the full file by explicit opt-in; default exports
   strip secrets and VACUUM.

---

## 5. Enforced invariants

Each row: what is promised, the file that enforces it, and the test that would fail if it
regressed. A row that could not name both is not here — it is in §6.

Paths are repo-relative. A mechanical check (`pnpm run check-threat-model`) verifies that
every path in this table still exists, so a refactor that moves an enforcement point cannot
silently leave this document citing a file that is gone.

### C1 — the token boundary

Credentials never enter the app iframe, never reach the LLM, never reach a publisher.

| Invariant | Enforcement | Test |
|---|---|---|
| An app cannot send a credential-shaped header across the bridge | `packages/protocol/src/frames.ts` — `netRequestSchema` refuses `STRIP_HEADERS` names; the whole frame is malformed | `packages/runner/src/__tests__/host-net.test.ts` — a credential-carrying request is answered MALFORMED, handler never called |
| The runner is value-blind — it never imports the credential layer | `packages/runner/src/host.ts` relays; no `@snugprotocol/auth` dependency exists | `packages/runner/src/__tests__/net-value-blind.test.ts` — source-walking lint over shipped sources |
| Injected credential values are scrubbed from response bodies, headers and error messages | `packages/auth/src/scrub.ts`, applied at the executor's delivery seat in `packages/auth/src/connected-fetch.ts` | `packages/auth/src/__tests__/scrub.test.ts` |
| A provider's error body cannot carry credential material out of the OAuth seat — **in either spelling** | `packages/auth/src/oauth-service.ts` — **the value scrub is the control**: the submitted secret values are known exactly here (`postForm` holds the `URLSearchParams` it sent) and are scrubbed on both sides of the extraction, as **both the decoded and the percent-encoded form**. The encoded candidate is derived from `URLSearchParams` itself, because that is the serializer that actually wrote the request and it disagrees with `encodeURIComponent` on space. `packages/auth/src/provider-error-detail.ts` bounds *volume and shape* only, and re-scrubs its own output because `JSON.parse` decodes `\u` escapes | `packages/auth/src/__tests__/oauth-error-echo.test.ts` (incl. a base64-shaped token whose two spellings differ — see the v3 note below), `packages/auth/src/__tests__/provider-error-detail.test.ts` |
| Host-bound injection is strict always — no bypass flag exists | `packages/auth/src/app-host-freeze.ts` (exact-hostname, punycode-normalized both sides) | `packages/auth/src/__tests__/browser-safe.test.ts` — source lint **plus a runtime signature walk** over real exports |
| Hub-bound sync and default exports carry no secrets | `packages/db/src/userdb/userdb.ts` — strip then VACUUM | `packages/db/src/userdb/__tests__/auth-custody.test.ts` |
| Credentials never reach the LLM's context | `apps/playground/src/agent/providerTools.ts` renders the already-scrubbed result | `apps/playground/src/__tests__/providerTools.test.ts` — asserts the credential reached the *wire* and is absent from the *model-bound string* |

### C2 — sandbox integrity

| Invariant | Enforcement | Test |
|---|---|---|
| App iframes are `sandbox="allow-scripts"`, never `allow-same-origin` | `packages/runner/src/react/SnugAppFrame.tsx` — static literal on the only production frame | `packages/runner/src/__tests__/source-guard.test.ts` (package) and `scripts/check-sandbox-guard.test.mjs` (workspace-wide — a widened frame in any app directory fails) |
| Apps have no network of their own (`connect-src 'none'`) | `packages/runner/src/csp.ts` — frozen `RUNNER_CSP`, injected via DOM parse | `packages/runner/src/__tests__/csp.test.ts`; real-browser probes in `apps/desktop/src/gate/csp.ts` |
| The CDN allowlist is fixed and the policy is not parameterizable | `packages/protocol/src/constants.ts` — module-level `as const`; `injectCsp` has arity 1 | `packages/runner/src/__tests__/source-guard.test.ts` |
| A self-navigating app is permanently cut off | `packages/runner/src/host.ts` — navigation credits, consumed in full, fail closed | `packages/runner/src/__tests__/host-lifecycle.test.ts` |
| Shell IPC is unreachable from a sandboxed subframe (macOS) | `apps/desktop/src-tauri/capabilities/main.json` + the invoke-key gate | `apps/desktop/src/gate/ipc.ts`, run by the in-shell gate — **see R-11 on cadence** |
| The token-releasing sidecar command is unreachable from a sandboxed subframe — proven per command, not by family | `apps/desktop/src-tauri/src/lib.rs` registers `sidecar_wizard_fetch` separately from `sidecar_fetch`, and `apps/desktop/src-tauri/src/sidecar.rs` fronts the wizard route table with it (`GET /pair/status` releases the helper's access token); capabilities are per-window, so the invoke-key gate is the actual wall | `apps/desktop/src/gate/ipc.ts` — `ipc-sidecar-wizard-fetch-refused` (a keyless, well-formed invoke of `/pair/status` from a srcdoc frame, on its own callback slot) **plus** `ipc-sidecar-wizard-fetch-dispatchable`, the positive twin — **see R-11 on cadence** |
| The shell's UPDATE commands are unreachable from a sandboxed subframe — per command, not per family | `apps/desktop/src-tauri/capabilities/main.json` grants `updater:default` + `process:allow-restart` to the main WINDOW only — but capabilities are per-window, never per-frame, so the invoke-key gate is the actual wall | `apps/desktop/src/gate/ipc.ts` — `ipc-updater-check-refused`, `ipc-updater-install-refused`, `ipc-process-relaunch-refused` (keyless well-formed invokes from a srcdoc frame) **plus** `ipc-updater-check-dispatchable`, the positive twin — **see R-11 on cadence** |
| The shell's HELPER-INSTALL command (download-and-execute-as-user, ADR-0060) is unreachable from a sandboxed subframe — per command | `apps/desktop/src-tauri/src/lib.rs` registers `helper_install` separately; every guard (signature, content pin, admission, caps) is Rust-side | `apps/desktop/src/gate/ipc.ts` — `ipc-helper-install-refused` (keyless well-formed invoke from a srcdoc frame) **plus** `ipc-helper-status-dispatchable`, the positive twin |

### The network ceiling

| Invariant | Enforcement | Test |
|---|---|---|
| An app reaches only hosts the user approved into that connection's frozen ceiling | `packages/auth/src/app-host-freeze.ts` — exact hostname; empty set fails closed | `packages/auth/src/__tests__/connected-fetch.test.ts` — suffix tricks, case, userinfo |
| SSRF literals are refused even when present in a ceiling | `packages/auth/src/net-guards.ts` — loopback, RFC-1918, link-local/metadata, CGNAT, IPv6 forms; malformed fails closed | `packages/auth/src/__tests__/net-guards.test.ts` |
| Redirects are never followed on any transport | `packages/auth/src/connected-fetch.ts` (`redirect: 'manual'` + status check); `apps/desktop/src/platform-desktop.ts` (`maxRedirections: 0`) | `packages/auth/src/__tests__/connected-fetch.test.ts`; `apps/desktop/src/__tests__/netTransport.test.ts` |
| Mutating methods require the user's confirmation **before** any credential is read | `packages/auth/src/connected-fetch.ts` — gate 6 precedes gate 8 | `packages/auth/src/__tests__/connected-fetch.test.ts` — a denied POST performs no fetch and resolves no credential |
| …including sends to the WhatsApp helper | `packages/auth/src/connected-fetch.ts` — gate 6a, after gate 6 | `packages/auth/src/__tests__/sidecar-transport.test.ts` — confirmed-first, denied-never-sends, GET positive twin |
| Two approved rows claiming one host refuse rather than tiebreak | `packages/auth/src/connected-fetch.ts` — `NET_AMBIGUOUS_CONNECTION` | `packages/auth/src/__tests__/slot-routing-regression.test.ts` |
| An app cannot mutate the ceiling, and a staged edit cannot widen it pre-approval | `packages/db/src/userdb/userdb.ts` — reserved table prefixes; frozen `allowed_hosts` | `packages/auth/src/__tests__/connected-fetch.test.ts` |
| Imported connection rows cannot serve traffic | `packages/db/src/userdb/userdb.ts` — demote to `declared` + `imported=1` | `packages/auth/src/__tests__/connected-fetch.test.ts` |
| An app holding a sidecar connection FACT (any status — a `declared` imported row binds too) has its LLM-bound payloads scrubbed of observed third-party identities and jid/dialable primitives, guarded inside BOTH leaf transports and the provider lane's sidecar-class results (classified by the canonical `parseConnectionUrl` grammar with the executor's own normalization); the app-message guard fails closed on an unreadable directory, the provider lane surfaces scrub failures as tool errors, malformed envelopes take the scrubbed raw path. NOT covered, by design: the chat data lane's replay of app-persisted rows (R-9 disclosed residual) | `apps/playground/src/agent/pseudonymizeEgress.ts` (per-send guard in `createDirectAppTransport` + `createServerAppTransport`) + `apps/playground/src/state/sidecarIdentity.ts` (harvest at the `sidecarAppFetch` seat; session-scoped memory reset on import/restore/revoke/delete) + `apps/playground/src/agent/providerTools.ts`; directory revoke-wipe in `packages/db/src/userdb/userdb.ts` | `apps/playground/src/agent/__tests__/pseudonymizeEgress.test.ts` (27, incl. scope negative, fail-closed, stale-predicate, declared-row, id-preservation) + `apps/playground/src/__tests__/sidecarIdentityHarvest.test.ts` (7, incl. C1 negative + session reset) + `providerToolsSidecarScrub.test.ts` (4, incl. non-canonical spellings) + `packages/db/src/userdb/__tests__/sidecar-identity-wipe.test.ts` (7, incl. import-survival) |

### Authoring and consent

| Invariant | Enforcement | Test |
|---|---|---|
| An LLM-authored requirement cannot borrow a registry provider's identity to author its own credential prompts | `packages/auth/src/requirement-admission.ts` — borrow ban with boundary-aware segment matching | `packages/auth/src/__tests__/channel-admission.test.ts` |
| A header template may only reference pinned helpers and declared fields, and lint and engine agree on every quoting shape | `packages/auth/src/template-lint.ts` + `packages/auth/src/template-engine.ts` — enforced at the render seat | `packages/auth/src/__tests__/template-parity.test.ts` |
| An app cannot forge starter authoring provenance | `apps/playground/src/starter/starterDeclaration.ts` — install source **and** both HTML versions must match bundled bytes | `apps/playground/src/__tests__/starterDeclaration.test.ts` |
| An app cannot claim a runtime contract, and an untrusted import cannot dictate one | `packages/db/src/userdb/userdb.ts` — canonical-bytes reconciliation, `trustedOrigin` keyed on the caller | `packages/db/src/userdb/__tests__/userdb.test.ts` |
| LLM-authored SQL cannot reach hub tables or other apps' data | `packages/db/src/driver.ts` — physical namespace separation; the bytes were never there | `packages/db/src/userdb/__tests__/scratch-run.test.ts` |
| Sidecar routes are admitted by an enumerated table in Rust, traversal checked on the decoded form | `apps/desktop/src-tauri/src/sidecar.rs` | cargo tests in the same file + `apps/desktop/src/__tests__/sidecarContract.test.ts` (parses the Rust source for drift) |
| The desktop shell has no generic path-read command | `apps/desktop/src-tauri/src/userfile.rs` (bare-name charset, `~/Snug` only); `apps/desktop/src-tauri/src/openfile.rs` (single-use, OS-delivered) | in-file cargo tests: `apps/desktop/src-tauri/src/userfile.rs`, `apps/desktop/src-tauri/src/openfile.rs` |
| A starter's release notes cannot describe bytes other than the ones shipping — an `app.html` edit without a release is a failing test, not a convention | `examples/validate.test.mjs` — recomputes sha-256 over the normalized html and compares `starter.json`'s `appHash` | `examples/validate.test.mjs` (the ADR-0045 block) |
| An installed starter's update lands as a NEW pinned version and never destroys the copy it replaces | `apps/playground/src/starter/starterUpdate.ts` — `saveAppVersion({pinned, contract})`, absent-only doc seed, declared-only connection refresh | `apps/playground/src/__tests__/starterUpdate.test.ts` |
| A shell update installs only artifacts signed by the pinned minisign key | `apps/desktop/src-tauri/tauri.conf.json` — `plugins.updater.pubkey`; verification happens in the updater plugin's Rust before install | `apps/desktop/src/__tests__/updaterConfig.test.ts` (pubkey present and well-formed; endpoint byte-equals the single-homed constant) |
| A shipped release points at the PRODUCTION update endpoint — a dev-overlay build cannot pass the release gate | `apps/desktop/gate/run-release-gate.mjs` — MUST-APPEAR byte-scan of the endpoint in the release binary | `apps/desktop/gate/run-release-gate.mjs` (run by `pnpm --filter desktop gate:release`) — **cadence caveat: this is a release-time gate, not a per-commit one** |
| The shell's own version cannot drift between its three declarations | `apps/desktop/package.json` · `src-tauri/tauri.conf.json` · `src-tauri/Cargo.toml`, bumped together by `scripts/release-desktop.mjs` | `apps/desktop/src/__tests__/versionSync.test.ts` |
| An update relaunch reaps the WhatsApp helper first — `AppHandle::restart()` skips `RunEvent::Exit` on the main thread | `apps/desktop/src/app-updates.ts` — explicit `sidecar_ctl('stop')` before `relaunch()` | `apps/desktop/src/__tests__/appUpdates.test.ts` — call-order spy |

---

## 6. Residuals — accepted and NOT mitigated

These are real. Several are sharp. None is mitigated by anything below its "bounded by" line.

### The two known defects

**R-5 — Windows: the invoke key is injected into sandboxed app iframes.** wry's WebView2
backend discards `for_main_frame_only`, so tauri's key-bearing `ipc-protocol.js` — with the
invoke key as a plaintext literal — executes inside `sandbox="allow-scripts"` app iframes.
Any app the user runs can read it. **This is a C1 *and* C2 break, not a weakening.** No
off-switch exists at the wry, tauri, or WebView2 SDK layer.
*Disposition:* **Windows desktop is not shipped, through alpha, beta and 1.0.** macOS is
unaffected — WKWebView honors the flag. No Windows build has ever been distributed and none
may ship in this configuration. Windows desktop is reconsidered **post-1.0**, as its own
decision; the preconditions are an upstream fix plus a green Windows gate leg plus
`cdp_jwt`'s native-ECDSA requirement verified there
([ADR-0021 D8 addendum](decisions/0021-desktop-shell-transports.md); root cause:
[`docs/solutions/2026-08-13-webview2-subframe-ipc-injection.md`](solutions/2026-08-13-webview2-subframe-ipc-injection.md)).

**R-5b — the build now states macOS-only, and a test holds it; what remains is narrower.**
Until 2026-08-20 this residual read "enforced by documentation, not by the build":
`tauri.conf.json` carried `"targets": "all"` and shipped `icons/icon.ico`. Both are now
gone — `bundle.targets` is `["app", "dmg"]`, the `.ico` is deleted, and
`apps/desktop/src/__tests__/bundleTargets.test.ts` pins all three facts (including the icon
generator, which writes that directory and would otherwise restore the file on the next
regeneration) in the manner of `netTransportCapability.test.ts`
(TASK-20260820-desktop-bundle-targets-macos).

*What that does and does not buy, stated exactly.* The build no longer **requests** a
Windows target, so no Windows artifact is produced by an ordinary `pnpm --filter desktop
bundle` on any host. It is **not** a refusal: an operator who passes `--bundles nsis`
overrides the config on the command line, and tauri accepts that flag on a foreign host
rather than rejecting it at config-parse time (verified 2026-08-20 on macOS — it proceeds
into the build). So the honest claim is *the shipped configuration requests macOS targets
only*, not *the build refuses Windows*. Deliberately no second mechanism (a host guard) was
added: the decision is a distribution policy, and one clearly-stated, tested config is
better than two half-mechanisms implying a hard stop that no build system here provides.

*The remaining detector gap is unchanged and is not this residual's to close.* The only
thing that would catch an actual R-5 regression in shell behaviour is the CI Windows leg
staying red *for the right reason* — and CI has been billing-blocked since ~2026-08-18,
failing in seconds with zero steps, so a red X from billing is indistinguishable from a red
X from R-5. That is an owner action tracked in `docs/next-steps.md`. Stated rather than
implied because R-5's severity makes the strength of its enforcement part of the claim.
*Errata 2026-08-26: CI is live again (ADR-0058), but the Windows leg was **removed** rather
than left red — it had been dying at compile (missing `icon.ico`) before ever reaching the
`keyReachable` assertion, so its red proved nothing. The R-5 detector gap therefore stands
until Windows returns post-1.0; `ci.yml` records what must come back with it.*

### Where the walls genuinely end

**R-1 — Host-page compromise means total credential compromise.** The host page holds every
credential and calls fetch; that has always been true and no gate below it helps. On
desktop this is *worse than in the browser*, and the deltas did not say so: the shell's main
window ships with `"csp": null`, so the layer a browser host page has is absent. Any XSS in
the host page is immediate full IPC plus `snug_secrets`.
*Bounded by:* the app-iframe boundary (C2) being the thing that keeps app code out of that
context in the first place.

**R-28 — The update manifest is TLS-trusted; only the ARTIFACT is signed.** The desktop
update channel ([ADR-0047](decisions/0047-desktop-distribution-and-update-channel.md))
verifies a minisign signature over the downloaded artifact, so an attacker who compromises
the publishing GitHub account **cannot install a binary**. They CAN control every word of
the prompt: version number, date, and notes prose come out of `latest.json`, which nothing
signs. The realistic attack is therefore social — a fabricated "critical security update"
whose notes steer the user somewhere the signature does not reach.
*Bounded by:* the version string being syntax-validated, notes rendering as plain text with
no linkification (pinned by test), the structured notes preferring the release's own asset
under the same rules, and the update UX deliberately offering the attacker no button to aim
— "later" and "update now" are the only actions, and neither leaves the app. Manifest
signing would close it and is not implemented.
*Full surface:* `docs/security/threat-model-delta-desktop-update-channel.md`.

**R-29 — First acquisition is trust-on-first-use.** *(Partially resolved 2026-08-24: builds
are signed and notarized as of v0.1.0.)* Distributed builds now carry a Developer ID
Application signature (Team 2KC5X47563), are notarized by Apple and have the ticket
**stapled**, so first launch is an ordinary double-click and a tampered DMG gets an OS-level
warning ours does not. The release pipeline refuses to stage an artifact that is not stapled
or that Gatekeeper does not accept as `source=Notarized Developer ID`, so this cannot
silently regress. What REMAINS: notarization proves the binary came from this Developer ID
and carries no known malware — it does not tell a user that *this* Developer ID is Snug's.
Nothing published today lets someone verify out of band that the identity signing the DMG is
the project's own, so first acquisition is still TOFU on the download link. Closing that
needs a published, independently-reachable fingerprint — filed, not done.

**R-30 — The launch update check is a phone-home.** With auto-check on (the default), every
desktop launch tells github.com the user's IP, the time, and the running version. Snug's
posture is "we collect nothing as architecture", and this is the first automatic outbound
request the desktop app makes that is not the user's own work. It goes to a third party we
do not control rather than to us, it is disclosed in Settings copy and toggleable — but a
user who wants zero background traffic has to discover the switch.
*Where the user is told (ADR-0055):* the DMG's license screen — the product's one clickwrap —
carries the sentence verbatim with the off-switch, and `/privacy` embeds the same
byte-pinned constant (`UPDATE_CHECK_DISCLOSURE`, `apps/playground/src/legal/legalShared.ts`;
`dmgEula.test.ts` pins the copies). The assent screen is the DMG's only: the updater
installs `Snug.app.tar.gz` in place with no screen, so a user who fetches that asset
directly meets the terms via Settings → about. Once a messaging account is linked, the
helper's launch-time reconnect (ADR-0037 §3) is a second automatic egress, named in the
same places.

**R-31 — An installed starter's update inherits the previous version's grants.** Data,
`auth:<appId>:*` credentials, approved connections and chat are all keyed on `app_id`,
never on version, so updated code inherits everything the prior code was trusted with
([ADR-0045](decisions/0045-starter-versioning-and-update-channel.md)). That is the point —
the alternative destroys the user's data — but it means the trust decision is "do I trust
the next version of this app", answered by first-party in-repo provenance rather than by
anything the user inspects. A changed requirement on an *approved* row still waits for the
user's own re-review; only `declared` rows refresh.
*Full surface:* `docs/security/threat-model-delta-starter-update-channel.md`.

**R-32 — Deleting the last sidecar-fact app reaches OFF the machine.** The Telepath deep
delete ends a WhatsApp linked-device session ([ADR-0046](decisions/0046-multi-provider-byok-and-app-lifecycle-controls.md)
§7): re-linking needs a fresh QR scan on the phone. It is almost certainly what a user
asking to remove Telepath wants, and it is the only act in the product whose blast radius
extends to a third-party account's device list. Named in the delete confirmation copy.
*Bounded by:* firing only after the cascade commits, only when no other app holds a sidecar
fact, and behind a persist tombstone that silences every writer that could otherwise
resurrect the wiped store.

**R-33 — The helper download is the first path by which the shell fetches and executes code
other than itself, and its residuals are stated rather than closed.** (ADR-0060; delta S9.)
Archives are minisign-signed with the updater key AND content-pinned in the shell (per-arch
sha256 in `src-tauri/helpers.json`), so a compromised release account can substitute nothing the
shell will run — the pin, not the signature, is what binds identity. What REMAINS: (1) a
**developer install** (`kind: "dev"` stamp, or a stampless legacy tree) is never overwritten
and only *reported* as mismatched — the owner's own machine is exactly this case, so its
hardware walks do not exercise the pinned path unless the dev tree is rebuilt; (2) the
bundled Node runtime is trusted through a committed sha256 pin (`node-runtime.json`) — a Node
CVE now implies a helper re-release, and nothing automates noticing one; (3) quarantine does
NOT apply to files the shell writes (Tauri sets no `LSFileQuarantineEnabled`), which is why an
unsigned-by-us `bin/node` launches — adding that key would break helper launch, and this is
the only place that is written down; (4) there is no uninstall surface (~140 MB per helper);
(5) the x86_64 archive is verified only under Rosetta until an Intel walk.
*Full surface:* `docs/security/threat-model-delta-desktop-update-channel.md` §S9 / R-e.

**R-2 — A scrubber that matches values cannot survive re-encoding.** `scrubAuthValues` is
exact-substring over injected values, in raw and percent-encoded form. A provider that
echoes a credential base64'd, hex'd, or split across fields defeats it — *by design*, and
the code documents its own boundary. Sharper still: when a template sends
`{{base64(secret)}}`, the candidate set holds the base64 form only, so a cooperating
endpoint that decodes and reflects the *underlying* secret reflects it in the clear.
*Bounded by:* the frozen host ceiling, which was always the primary wall. Inherited from the
Dynamic Auth v2 delta.

**R-3 — The OS user account is the perimeter, unless the user protects the file.**
By default `~/Snug/user.snug` is a plaintext file and any process running as the user can
read it, along with the WhatsApp helper's socket and key store. This is exactly the custody
[ADR-0014](decisions/0014-credentials-local-first.md) promises — the user owns the file —
not an oversight.

Since 2026-08-20 the user may opt into **whole-file passphrase encryption**
([ADR-0043](decisions/0043-passphrase-encryption-at-rest.md)): AES-256-GCM over the entire
database, key wrapped by PBKDF2-SHA256 (600k) from a passphrase and, independently, from a
mandatory Recovery Key. When it is on, A6 reads ciphertext and must guess offline; the
protection travels with exports and personal-origin sync copies.

*What it does NOT do,* stated plainly because the gap is the interesting part:
- it does not defend a **running, already-unlocked host page** — R-1 is unchanged, and a
  compromised host holds the plaintext database and every credential in it;
- it does not defend a device **while the passphrase is being typed**, or one where the
  attacker can observe the process;
- it is **not** zero-knowledge and **not** end-to-end encrypted — it is at-rest encryption
  with a key the user holds ([ADR-0014 §5](decisions/0014-credentials-local-first.md)
  bounds what may be claimed);
- hub-origin sync copies are still **plaintext** (secrets-stripped, per ADR-0014), by
  decision — that copy carries no credentials, so encrypting it would change the `/userdb`
  contract for no privacy gain.

Full-disk encryption and OS keychain wrapping remain out of scope pre-1.0; the
KeyProvider/KMS track is still the roadmap answer for hosted custody.

**R-4 — An approved-but-hostile header template routes a secret to an odd header of an
already-allowed host.** The lint bounds *what* a template references, never whether
referencing it *there* is sensible. `X-Debug: {{api_key}}` lints clean and renders the live
secret.
*Bounded by:* the frozen ceiling (who receives it) and the human who read the template
verbatim in review. **There is no third control** — which is why review renders templates
uncollapsed and host lists uncapped. If the review screen ever degrades, this trade stops
paying. Inherited.

**R-6 — TOFU pairing window.** An attacker already on the user's network at the moment of
first pairing is pinned instead of the real bridge, and every later request is faithfully
delivered to them. Signify-CA pinning is deferred for structural reasons (gated CA material;
old bridges are self-signed).
*Bounded by:* attacker presence at that exact moment; a user-typed address; and once pinned,
a later MITM fails closed. Inherited.

**R-7 — The feature lane has no pre-write gate.** A prompt injection that flips a data
question into an app change writes a new app version without a confirm. The data lane's
writes end at a human gate; the feature lane's land on model authority.
*Bounded by:* versioning, a visible in-place reload, and revert — so the outcome is a
reviewable version write, not a silent mutation. An explicit owner decision, revisitable.

**R-8 — Untrusted text reaching a model can steer it, and bounding cannot remove that.**
App rows, provider bodies, and other people's messages are untrusted prompt input by
construction — showing the model the user's data is the entire feature. Fenced blocks with
defanged closing tags, the instruction restated after the block, bounded results, per-turn
call caps, and fail-closed classification narrow the window; none closes it. The wall that
actually holds is the confirm dialog naming host, method and URL on every mutating call.
*One sharpening this document adds:* replayed conversation history reaches the intent
classifier as bare list items **outside** the fence the rest of the pipeline uses, and the
defang covers one tag spelling. Same class as the above, weaker containment than the
provider-chat-lane delta's wording implies. Bounding the replay narrows it further than
this text once admitted: history is capped at two turns of 300 characters each.

*v3 correction (2026-08-21).* Until this pass the sentence above was **false about the
control it leans on**: the modal confirm rendered app, host and method only — the URL was
supplied by the executor and never displayed, though the chat-lane card had always shown
it. Host and method alone cannot distinguish `POST /notes` from
`POST /transfer?to=attacker`, which is precisely the difference an injected instruction
exploits. The dialog now renders the URL verbatim
(`apps/playground/src/run/NetConfirmDialog.tsx`, pinned by test). A second honesty gap was
closed with it: the session-remember grant is keyed `(appId, host, method)` with **no path
component**, so approving one benign POST authorizes every POST path on that host for the
session — the checkbox now says so ("any path").

**R-9 — Third-party consent, now behind a host-enforced backstop that is honest about its
class.** The other participants in an analysed WhatsApp thread never consented, are not
Snug users, and cannot opt out; under BYOK their messages reach the user's configured model
provider — pseudonymised or not, the CONTENT goes, and that is the part no scrub removes.
Since TASK-20260820-host-pseudonymisation the scrub is no longer only an app-layer
convention: the host harvests identities (contact names, jids) from sidecar `/chats`
responses at the one seat every governed sidecar read crosses
(`apps/playground/src/state/sidecarIdentity.ts`, fed from `sidecarAppFetch`), persists them
in `snug_settings` (a **third-party-PII asset** in its own right — wiped when the last
approved sidecar-ceiling connection is revoked or its app deleted; it deliberately
SURVIVES an import, whose demoted-to-`declared` rows still travel with the replayable app
data the scrub exists for, and it rides the `.snug` export until the wipe), and redacts
them plus the jid/dialable-digit-run primitives from every LLM-bound surface of every app
holding a sidecar connection FACT in any status — approved, declared-by-import, or
revoked-with-data-left-behind: the app-message envelope (`state`, `payload`, `action`,
`responseSchema` — envelope ids pass verbatim so the model's echo still correlates, a
disclosed ≤128-char residual channel) before both the BYOK and `/invoke` transports
(`apps/playground/src/agent/pseudonymizeEgress.ts`, guarded inside both leaf producers),
and sidecar-class tool results on the provider chat lane, classified by the canonical
connection-URL grammar with the executor's own normalization. The app-message guard fails
CLOSED — an unreadable directory refuses the send; the provider lane surfaces a scrub
failure as a tool error string, never the raw body. A malformed envelope is scrubbed as a
raw string with an unescape-normalised shadow pass. The shipped app's own stable-label
scrub remains on top as defense in depth, so a feature-lane rewrite of the app (R-7) no
longer removes the boundary.
*Honest statement of class:* the backstop is **anti-default and anti-naive, not
anti-adversarial.** Disclosed residuals: an app that obfuscates (homoglyphs, base64, phone
numbers smuggled as JSON *numbers* — `ts` is legitimately a 10-digit number, so numerics
pass), or glues an identity to word characters, defeats substring redaction; identities
never surfaced through the sidecar seam (a nickname typed only inside message text) are
invisible to the directory; raw rows an app persisted in its own tables can still reach a
model through the data lane (`data_read` results and replayed chat turns), which is
app-shaped and not scrubbable at this seam; and message content itself reaches the provider
by design. Third-party consent therefore remains a real residual — but the "guard not
where the docs put it" defect this section previously recorded is closed.
*Where the user is told (ADR-0055):* on the linking screen itself, before "start linking"
(`linked-device-third-party-band`, TASK-20260823-legal-terms-privacy-eula), and in the
published privacy statement's third-party table — disclosure sits beside the control, never
in place of it.

**R-10 — ToS and account-ban risk.** Unofficial WhatsApp automation violates WhatsApp's
terms and accounts have been banned for it. Pacing and rate caps are harm reduction, never
detection evasion, and are not a guarantee. Disclosed in the wizard consent copy and the
starter README before the user connects — and, since ADR-0055, on the linking screen's
third-party band and in `/terms` + `/privacy`.

**R-27 — A protected file whose secrets are both lost is unrecoverable.**
[ADR-0043](decisions/0043-passphrase-encryption-at-rest.md) has no backdoor, no escrow and
no reset: if the user loses BOTH the passphrase and the Recovery Key, the data is gone. That
is the property the feature exists to provide, so it cannot be mitigated away — only
disclosed and designed around. What bounds it:
- protection is **opt-in**, and the cost is stated on the same screen as the offer, before
  any commitment — never on a later screen;
- a **Recovery Key is mandatory**, not optional: `encryptContainer` refuses to build a
  single-slot container, so no user can end up with exactly one way in;
- the key is shown once behind a **mandatory acknowledgement checkbox** (a typed phrase
  until TASK-20260821-site-playground-polish), with copy/download/print — finishing the
  screen without acknowledging stays impossible, because clicking through it unread is
  the path that ends here;
- the unlock screen offers **no destructive escape** (no "start fresh"), so a tired user
  cannot trade their data for relief, and it names the Recovery Key as the way out;
- turning protection **off** is always available from Settings while the file is open.
*Accepted by the owner as the cost of the R-3 improvement, with the mitigations above.*

### Enforcement cadence — where "tested" is weaker than it sounds

**R-11 — Several C2 guarantees are proven by real-browser probes that CI runs on one
engine only.** AC3 asks for "the test that would fail if it regressed"; for these rows the
answer depends on which engine you mean. *Errata 2026-08-26 (ADR-0058,
TASK-20260826-backlog-hygiene-stale-findings): v3 wrote this row as "a CI job that has not
executed since ~2026-08-18". CI has been live and enforcing since 2026-08-26 — `workspace`
and `desktop-shell (macos-latest)` are required checks — so that premise is stale; the
coverage gap below is not.* What CI proves today: the in-shell hard gate (AC7/AC8) runs on
every push and PR via the macOS `desktop-shell` job, so the **WKWebView** leg of the 14
real-browser CSP checks is live evidence. What it still does not prove: the **WebView2**
leg is parked with the Windows desktop (the leg was removed rather than left red, for the
reason the workflow file records); the CSP checks never run under **Chromium**, which is the
engine the hosted Playground ships to (no `e2e` turbo task on the web path); and
`apps/server`'s CSP-header assertion lives in `smoke.ts`, which CI never invokes. The
unit-level pins (policy text, decision functions) do run everywhere; what remains
unproven in CI is *actual webview behaviour* on the engine most users meet.

**R-12 — Per-command IPC proof is a rule that does not cover every command.** The gate
identifies commands individually, precisely so a new command inherits nothing.

*v3 (2026-08-21) re-derived this from source, because v2's figures — "ten commands ship;
three carry per-command checks" — were stale in both numbers and silently compared two
different sets. The honest census:*

| Set | Count | Per-command keyless probe |
|---|---|---|
| Registered in `generate_handler!`, **release** | 10 | 4 — `write_user_file` (via the sentinel, the strongest instrument here), `lan_fetch`, `sidecar_fetch`, `sidecar_wizard_fetch` |
| Registered in `generate_handler!`, **debug** | 13 | the 3 extra are the `gate::*` trio, which exist only to run the gate |
| Tauri **plugin** commands (never in `generate_handler!`) | 3 | 3 — `plugin:updater\|check`, `plugin:updater\|download_and_install`, `plugin:process\|restart` |

**The named exception is now CLOSED.** `sidecar_wizard_fetch` — which fronts the wizard
route table including `GET /pair/status`, the token-releasing route, and auto-injects the
spawn nonce host-side — carried no per-command row through v2 while its *lower*-privilege
sibling did. TASK-20260821-launch-security-review added `ipc-sidecar-wizard-fetch-refused`
(a keyless well-formed invoke of that exact route from a sandboxed srcdoc frame, on its own
callback slot) plus `ipc-sidecar-wizard-fetch-dispatchable`, the positive twin.

*What remains, stated exactly:* six release commands still have no per-command row —
`read_user_file`, `read_opened_file`, `export_user_bytes`, `sidecar_ctl`,
`pending_opened_files`, `close_flush_done`. None releases a credential, and the three
key-absence checks are shared, so if the invoke key is absent no command is reachable at
all. That shared check is what actually bounds this residual; the per-command rows exist
because registration is per-command and a family-level check cannot see a command added to
the wrong handler list.

### Smaller, stated rather than discovered

- **R-22 — A pasted setup token can bind a connection to someone ELSE's account.** The
  SimpleFIN claim URL inside a token names a *bridge account*, not a user. A user
  social-engineered into pasting an attacker's token binds the connection to the attacker's
  bridge: the app then renders the attacker's transaction feed as though it were the user's.
  No user credential or user data crosses in either direction — **the harm is deception,
  not disclosure** — and single-use token semantics bound replay. Bounded by wizard copy
  telling the user the token comes from *their own* SimpleFIN Bridge account. Worth stating
  because it is the only residual here whose payload is a false picture of the user's own
  finances rather than a leak.
- **R-23 — A pinned third party custodies real bank credentials.** SimpleFIN Bridge holds
  the user's bank logins server-side — that is its product — and mints read-only feeds.
  Snug's boundary starts at the minted access URL; a Bridge compromise is outside it and
  no control here reaches it. Disclosed to the user in the registration walkthrough ("your
  bank passwords stay with SimpleFIN — they never touch Snug"). Called out separately from
  §1's out-of-scope line about third-party infrastructure, because this is a *first-party
  pinned dependency*, not a deployment the user chose.
- **R-24 — The C1 credential scanner misses keys embedded in prose.** `KNOWN_KEY_PREFIX` is
  `^`-anchored, so a payload reading `"Use key sk-ant-…"` passes the envelope-boundary scan.
  This applies to the `payload`/`state` envelope path and the runtime-contract seat alike —
  the contract seat is therefore *no weaker* than the envelope seat, which is the only claim
  it makes; it is not airtight. Widening the pattern is a scanner-level change with its own
  false-positive budget. A test pins the limit honestly rather than implying otherwise.
- **R-25 — Write-approval drift detection compares COUNTS, not rows.** A concurrent change
  that leaves the affected-row count identical while changing *which* rows match passes the
  check — row 5 rewritten in place, or one row deleted while another starts matching the
  same predicate. The window is between preview and approval, and the writer would have to
  be the app itself or a concurrent sync. Closing it means hashing the affected rows at
  preview and re-checking at execute. This is a consent-integrity residual: the user
  approved a specific change, and what executes can differ from what they read.
- **R-13 — DNS rebinding for public hostnames.** The LAN policy keys on IP literals; a
  public name rebinding to a private IP mid-flight is refused only as a *name*. Native
  resolve-then-connect-by-IP is deferred. The ceiling still bounds which names are reachable.
- **R-14 — The ceiling does not bound ports, paths, methods or query strings.** Any path on
  an approved host is reachable, including a debug/echo endpoint — the precondition R-2
  depends on. Port is deliberately not part of host identity.
- **R-26 — Provider error prose is forwarded on a bounded, best-effort basis.** When a
  provider's error body is not a recognized envelope, up to 160 characters of its head are
  forwarded so a human sees *some* reason. Nothing keeps credential material out of that
  head except the value scrub at the calling seat — the extractor bounds volume and shape,
  never content. The scrub covers what the caller can name (the submitted OAuth params; the
  injected credentials for that request), so a secret the caller never sent and never
  injected — say, a *different* credential the provider chose to mention — would pass. The
  same exact-substring limit as R-2 applies to what it does cover.
- **R-15 — Credentials in URLs reach surfaces we do not own** — server logs, proxies,
  referrers, history. Every site we own is scrubbed; theirs cannot be. Inherited.
- **R-16 — No per-app rate limit on the net executor.** Serial requests are unlimited — an
  app can burn the user's provider quota. The ceiling bounds *which* hosts are reachable,
  so this is not an open amplifier. The one concurrency bound is `MAX_IN_FLIGHT = 8` in
  `packages/runner/src/host.ts` — note it lives in the **runner host**, not the executor,
  and covers all in-flight frames (db and net together) for one runner instance rather than
  net requests per app. Stated precisely because "capped at 8" invites an auditor to go
  looking for a cap in the executor, where there is none.
- **R-17 — The BYOK browser-CORS advisory.** Some providers refuse browser-origin calls;
  the registry's `browserCallable` flag is human-authored and *absent means unknown*, which
  is disclosed as unknown rather than assumed callable. The desktop shell's native fetch is
  the answer for those providers — which on a macOS-only shell means some BYOK providers
  are unreachable from the web Playground and have no desktop path for Windows users.
- **R-18 — Installed-starter staleness.** Sample-mode and authoring-provenance improvements
  reach **new installs only**; an already-installed copy reports `html_mismatch` against new
  factory bytes and keeps its old behaviour. A user's installed shelf is not the shelf the
  repo describes.
- **R-19 — Pure-ASCII lookalike provider names** (`5potify`, `Spotlfy`) that share no
  segment with a registry key are admitted; the brand-adjacent family (`Spotify Inc`) is
  caught. Bounded by the host-intersection ban and the review's provenance copy — reopen if
  that copy softens. Inherited.
- **R-20 — An untrusted import can carry an attacker's pin and secret under a row.**
  Pre-existing and general — it carries OAuth tokens and API secrets too, not just LAN pins.
  Bounded by local-secrets-win-the-merge and imported rows demoting to `declared`, requiring
  fresh human approval. Queued as its own task.
- **R-21 — `'unsafe-eval'` and `'unsafe-inline'` in the app CSP.** Babel-standalone compiles
  JSX in-browser, so eval *is* the execution model; nonces are meaningless when the document
  author is the untrusted LLM. The CDN allowlist is a supply-*availability* control, not an
  integrity one: anything on those CDNs can run in the sandbox. Accepted because the sandbox
  has nothing to steal and nowhere to send it — which is exactly why the C2 rows in §5 are
  load-bearing. Revisit trigger: apps shipping precompiled.

---

## 7. What this model does not claim

- **No cryptographic custody claim.** Not zero-knowledge, not end-to-end encrypted, not
  host-blind. The honest term is **publisher-blind**, and it stays that way until a
  KeyProvider/KMS ships ([ADR-0003](decisions/0003-v1-scope-and-security-constraints.md),
  [ADR-0014](decisions/0014-credentials-local-first.md) §5).
  **Optional at-rest encryption ([ADR-0043](decisions/0043-passphrase-encryption-at-rest.md))
  does not change this.** It protects the file where it sits and where it travels; it says
  nothing about custody, because the key was always the user's and still is. The claim it
  supports is exactly *"your file can be encrypted with a passphrase only you hold"* — never
  "zero-knowledge", never "end-to-end encrypted", and never a claim about a running host
  page (R-1) or an unlocked session.
- **No claim that prompt injection is solved.** It is contained, at named points, with the
  residual stated (R-8).
- **No claim of formal verification, external audit, or a bug bounty.** This is a
  solo-maintained project; §5's tests and the adversarial pass behind this document are the
  evidence, and both are re-runnable by anyone who clones the repo.

---

## 8. The deltas this consolidates

Each per-change delta remains the detailed record for its change. The hashes below are
pinned by `pnpm run check-threat-model`: a new delta, or an edit to an existing one, fails
that check until this model has been re-read against it.

**What that mechanism does and does not prove.** It proves a delta has not moved beneath
this document — it forces a human to *look* again. It cannot prove the looking was any
good: a hash says nothing about whether a delta's residuals were actually carried into §6.
The Gate-5 review of this very document found three that were not (SimpleFIN's
wrong-account binding and bank-credential custody, and the count-vs-row drift limit), and
the checker was perfectly green while they were missing. They are now R-22 through R-25.
The "consolidated into" column below is human-maintained prose, not a verified mapping —
treat it as a reading aid, and read the delta itself when the answer matters.

**v2 note (2026-08-21).** Four rows were added. Three are new surfaces; the FIRST —
`threat-model-delta-snug-file-encryption.md` — is a *retroactive* delta for a change that
amended this model in place without leaving one, which is exactly the gap this ledger
exists to make visible and which the ledger could not see (a delta that never existed
cannot fail a hash check). Its content is not new; the record is.

<!-- DELTA-LEDGER:BEGIN -->

| Delta | Pinned hash | Consolidated into |
|---|---|---|
| `docs/security/threat-model-delta-connection-addressing.md` | `22f12227195b` | §5 ceiling · R-14 |
| `docs/security/threat-model-delta-desktop-auth.md` | `f7e88cee2235` | §4 · R-1, R-2, R-5, R-6, R-15, R-20 |
| `docs/security/threat-model-delta-desktop-shell.md` | `edf449473757` | §5 C2 · R-1, R-3, R-13 |
| `docs/security/threat-model-delta-dynamic-auth-v2.md` | `8bae299b6bb2` | §5 authoring · R-2, R-4, R-19 |
| `docs/security/threat-model-delta-lean-runtime-data-chat.md` | `bec065ca9633` | §5 authoring · R-7, R-8, R-24, R-25 |
| `docs/security/threat-model-delta-provider-chat-lane.md` | `6f92151dad7c` | §5 ceiling · R-8 |
| `docs/security/threat-model-delta-simplefin-token-claim.md` | `e8cb2f9a8acd` | §5 ceiling · R-1, R-22, R-23 |
| `docs/security/threat-model-delta-whatsapp-sidecar.md` | `080e64034de0` | §5 ceiling · R-3, R-9, R-10, R-12 |
| `docs/security/threat-model-delta-snug-file-encryption.md` | `77bfcb19bfa3` | §2 assets · §5 C1 · R-3, R-27 |
| `docs/security/threat-model-delta-starter-update-channel.md` | `5a5625c1f999` | §5 authoring · R-31 |
| `docs/security/threat-model-delta-multi-provider-byok.md` | `540490f88a1c` | §5 authoring · R-32 |
| `docs/security/threat-model-delta-desktop-update-channel.md` | `2f6321918cce` | §5 C2 + authoring · R-28, R-29, R-30, R-33 |

<!-- DELTA-LEDGER:END -->

---

## 9. Audit record

This document was written after an adversarial pass, not from the deltas alone. Five
fresh-context audits ran in parallel — the sandbox/CSP seam, the credential boundary, the
net executor and allowlist, the desktop shell, and the app-authoring/prompt-injection
surface — each returning claim → enforcement point → test → verdict with file:line evidence,
and each instructed to try to break what it read.

**Result:** roughly fifty claims checked; the large majority held, with negative tests that
assert *zero fetches* rather than merely a failed result. Around a dozen file:line citations
drawn from the deltas were spot-checked and all were accurate. Two defects were found and
**fixed before this document was written** rather than described as residuals:

1. **The sidecar send skipped the mutating-confirm gate** — it returned 28 lines before
   gate 6, under a comment asserting the gate had answered. Fixed; three tests now pin
   confirmed-first, denied-never-sends, and a GET positive twin. The suite had been green
   because every sidecar test hardcoded a granting gate, making a gate that was never
   consulted indistinguishable from one that granted.
2. **OAuth token-endpoint error bodies reached both the iframe and the LLM unscrubbed** —
   500 raw chars of a provider's non-2xx response, on the path where the executor's own
   refresh POSTs `refresh_token` and `client_secret`. Fixed by bounding at the seat, reusing
   the existing recognized-envelope extraction discipline.

Both were reachable, both are the shape a delta would not catch — one because the comment
asserted the ordering the code did not have, the other because every relevant assertion
read `code` and never `message`. That is the argument for auditing rather than transcribing,
and it is why §6 above should be read as a genuine list rather than a formality.

### The v3 pass (2026-08-21) — the pre-launch audit

Seven fresh-context lanes ran in parallel against a single committed tree, each required to
return claim → enforcement `file:line` → probe → verdict, and each briefed that a finding
without a runnable probe is an argument rather than a finding. Lanes: C1 credentials · C2
sandbox + the desktop IPC census + the sidecar's own HTTP surface · the net executor's ten
gates and the ceiling · prompt injection and LLM egress · spec-vs-code conformance ·
flip-public hygiene · the reference server and storage custody.

**Three defects were fixed in this pass, each test-first with the red recorded:**

1. **The OAuth error seat leaked the ENCODED spelling of submitted secrets.**
   `body.get()` returns a decoded value while `URLSearchParams.toString()`
   percent-encodes on the wire, so a provider echoing back what it literally received
   returned a spelling the raw-only candidate set could not match — and `scrubAuthValues`
   is exact-substring. Any base64-shaped credential (`+`, `/`, `=`) differs between the two
   forms, which is the ordinary shape of an OAuth refresh token. The resulting message
   reaches the app iframe, the LLM, and `snug_secrets` (as `lastError`, which rides a
   personal-origin sync). The sibling seat in `connected-fetch.ts` had learned this exact
   lesson at its query-injection candidates; this seat never inherited it. **The existing
   tests could not see it**: their fixtures were pure `[A-Za-z0-9-]`, for which encoding is
   the identity, so raw and encoded were byte-identical and every assertion passed whether
   or not the defense existed.
2. **R-8's load-bearing sentence was false.** The residual rests on the confirm dialog
   "naming host, method and URL on every mutating call"; the modal never rendered the URL.
   Fixed in the dialog rather than by amending the sentence, and the session-remember
   checkbox now discloses that its grant is path-blind.
3. **R-12's named exception was closed** — `sidecar_wizard_fetch` gained its own keyless
   refusal row and positive twin.

**A flip-public BLOCKER was also fixed, outside this document's usual scope but worth
recording**: a guard test in `packages/knowledge` hardcoded the real ancestor-system
codenames as a plaintext list annotated as such — a test written to prevent that exposure
was itself the exposure, in the file a curious reader would find most rewarding. The tokens
are hashed now, with substring semantics preserved and the planted-token sample recovered
by brute force rather than written down.

**What v3 did NOT do — stated because a pass that hides its own gaps is the failure mode
this section exists to prevent:**

- **No lane reviewed `packages/adapters` or `packages/sdk`.** A deliberate scoping call, not
  an oversight; both are named here so the gap is visible.
- **CI was billing-blocked at the time (since ~2026-08-18)**, so nothing here was verified by an
  independent runner — every green below is one machine. *(Errata 2026-08-26: CI has run
  as a required check on every push and PR since ADR-0058; the v3 evidence itself was
  still single-machine and is left as written.)* The evidence is `pnpm run
  gate:local --all` at **FULL PASS, 6/6 legs** (its own verdict: "equivalent to ci.yml on
  macOS", with the Windows leg named as having no local counterpart), plus a separate
  `pnpm --filter desktop gate` run at **GATE GREEN in a real WKWebView** — where both new
  R-12 rows executed and passed, so that closure is proven behaviourally and not merely
  unit-pinned. R-11's cadence gap is therefore narrower than at v2 for these rows, and
  unchanged for everything that still depends on CI.
- **No Windows verification of any kind.** R-5's only regression detector remains a CI leg
  that does not run.
- **The findings triaged as accepted rather than fixed** are in `docs/next-steps.md` with
  severity and evidence — notably the reference server's missing authorization on
  `/invoke` and `/artifacts` (bounded by ADR-0013: the shipped hub has no backend), the
  breadth of untrusted `.snug` import, three IPv6-embedding forms the SSRF literal guard
  does not cover, and a stale LAN-transport timeout that silences the executor's
  self-naming abort message.
- **Owner hardware walks remain owed** and no suite substitutes for them; they are listed
  in `docs/next-steps.md`.

---

*Reporting: [SECURITY.md](../SECURITY.md). Good-faith research under that policy is
authorized. Anything that makes C1 or C2 false is a critical finding, and we want to hear
it.*
