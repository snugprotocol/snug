# 0021 — Desktop shell transports: loopback OAuth, registry redirect postures, native fetch, file-backed userdb

- **Status:** accepted
- **Date:** 2026-08-12
- **Task:** TASK-20260812-desktop-hub-scaffold

## Context

Roadmap A6 (owner decision, pulled forward to Alpha) puts the hub client in a Tauri 2 native shell at `apps/desktop`: the launch-day artifact for LAN-class connectors, the CORS-wall fix for BYOK providers that refuse browser calls (next-steps 2026-08-12 advisory, rung 2), and the platform where Ollama-local "no key, no account" mode shines. The auth transport seams (`RedirectUriProvider`, `CallbackSink`, `FetchLike`, `FlowStateStore` — `packages/auth/src/oauth-service.ts`) were designed for exactly this ("localhost loopback when desktop returns", TASK-20260805-auth-core D-finding 8). No prior ADR covers redirect mechanics or desktop; ADR-0014 requires an ADR for anything custody-adjacent.

Provider redirect capabilities genuinely differ (Spotify: loopback literals only, `localhost` banned; Google-class: any-port loopback; Slack-class: https-only redirect URIs; GitHub/Google/Microsoft: device flow available). Pretending one mechanism fits all providers produces mid-flow failures; the registry is already the reviewed authority for provider auth shape (TASK-20260812-registry-authoritative-auth, ADR-0020).

## Decision

1. **Redirect posture is reviewed registry data, never a requirement seat.** `WellKnownOauthProvider` (and per-`WellKnownAuthOption`, flow-seat rules per ADR-0020) gains `desktopRedirectPosture?: 'loopback' | 'loopback-fixed-port' | 'custom-scheme' | 'https-bridge' | 'device-flow'`, human-authored against the provider's real dashboard, plus `browserCallable?: boolean` (the CORS-disclosure flag from the 2026-08-12 advisory; absent = unknown and disclosed as unknown). Nothing persists into `ConnectionRequirement` rows — the protocol schema, approval diffs, and spec are untouched; the wizard resolves posture at render/connect time via `lookupWellKnownProvider`. Postures the running shell does not implement (`custom-scheme`, `https-bridge`, `device-flow` at v1) **refuse honestly at wizard entry, before any credential is entered** — never a mid-flow failure.
2. **Loopback callback transport (desktop default) — and loopback requires PKCE.** `tauri-plugin-oauth` listener bound to `127.0.0.1` only; redirect URI `http://127.0.0.1:{port}/callback` — the IP literal, never `localhost` (Spotify bans it; RFC 8252 prefers it). `loopback-fixed-port` entries use the fixed desktop port **41420**; a bind collision is an honest wizard error, never a silent fallback port (a fallback would break the URI the user registered). Ephemeral ports only for `loopback` entries whose provider honors any-port loopback; the transport records the exact URI string at flow start and returns it verbatim to both service calls. The flow logic is untouched: HMAC-signed state, caller-held `expectedFlowId`, nonce single-use, PKCE S256. A forged-state hit on the listener dies at `verifyState`; the sharper attack — a local process racing the redirect with its OWN authorization code under the *valid* state — is defeated only by provider-side PKCE challenge binding. Therefore **a loopback posture on a `pkce:false` entry/option is refused structurally** (registry test): such providers take a non-loopback posture or have no desktop OAuth. The listener's response page carries zero token material.
3. **Provider logins open in the system browser only** (RFC 8252 §8.12; Google blocks embedded webviews). The webview never navigates to a provider; `tauri-plugin-opener` opens the authorize URL. The register-step copy and the OAuth service's `redirectUriProvider` draw the URI from ONE platform source (the web literal existed in three places; desktop must not add a fourth).
4. **Native fetch through the existing seams, guards unchanged in kind.** `tauri-plugin-http` (reqwest; CORS does not apply) is injected as `fetchImpl` at `createNetHandlerFor` and threaded to LLM adapters. The connected-fetch executor remains the only host-side fetch caller; injection stays strict (C1, no knob); manual-redirect and 1 MiB-cap semantics are contract-tested in-shell. **One deliberate scheme-policy widening, desktop only:** `http://` is permitted solely for RFC-1918 private-range IP-literal hosts that the user explicitly approved into the connection's frozen host ceiling (the Hue-class LAN rung). Public hosts stay https-only; loopback/localhost stays refused; the browser profile is byte-identical to today. DNS-rebinding for public hostnames remains a documented residual (native pin-resolution is a queued follow-up).
5. **File-backed userdb.** A `'file'` `PersistenceBackend` persists the user file at `~/Snug/user.sqlite` through Rust commands with temp+rename atomic writes; strict sqlite-magic reads and quarantine semantics carry over from the OPFS backend; the sync sidecar shares the backend; `flush()` runs on window close-requested. `tauri-plugin-single-instance` prevents two shells on one file. OPFS remains the web path, untouched.
6. **`.snug` file association.** Desktop registers `.snug` (same sqlite byte format; a filename convention, not a new format). Opened files (macOS `RunEvent::Opened`; Windows/Linux argv via single-instance) route through an explicit user confirmation into `importUserFile`, arming the F15 endpoint-confirm guard. No silent import.
7. **Desktop ships BYOK/local only.** No subscription surface in the shell (consistent with ADR-0013's posture); desktop remains a public PKCE client per ADR-0014 — BYO dev registration, no client secrets held for the user.

8. **C2's shell gate covers the IPC channel, not just CSP.** The 14 browser CSP checks are complete for a browser, where every iframe escape is CSP-governed; a native shell adds exactly one new channel — the Tauri IPC bridge — which CSP does not govern and which fronts the user-file commands and native fetch. The in-shell hard gate therefore asserts, from INSIDE a sandboxed srcdoc iframe, that the IPC handles are unreachable (or invocation is refused), with Tauri capabilities scoped to the main window only. A platform that injects IPC into subframes with no off-switch is structural breakage → Electron fallback. **(RESOLVED 2026-08-20 — the trigger fired on WebView2 and the owner chose macOS-only over the Electron fallback; see the D8 addendum below.)** The custom `snug` deep-link scheme is **reserved by name here only** — no OS handler is registered until the custom-scheme posture ships.

## Addendum — D8 resolved: macOS-only at 1.0 (2026-08-20)

- **Status:** accepted (owner decision, 2026-08-20) · **Task:** TASK-20260820-threat-model-v1

D8's trigger fired. wry's WebView2 backend discards `for_main_frame_only`
(`wry-0.55.1/src/webview2/mod.rs:492-494`), so tauri's key-bearing `ipc-protocol.js` — with
the invoke key as a plaintext literal — executes inside `sandbox="allow-scripts"` app
iframes. Any app a user runs can read it. No off-switch exists at the wry, tauri, or
WebView2 SDK layer. macOS is unaffected: WKWebView honors the flag
(`src/wkwebview/mod.rs:643-644`), gate 40/40 green. Root cause and citations:
[`docs/solutions/2026-08-13-webview2-subframe-ipc-injection.md`](../solutions/2026-08-13-webview2-subframe-ipc-injection.md).

**Decision: option (b) — the desktop shell ships macOS-only through alpha, beta and 1.0.**
Not (a) Electron, which trades a known-good platform for a rewrite of the shell folder to
buy a platform 1.0 does not need; not (c) upstream-and-wait, which puts the ship date
inside someone else's review queue. Windows is not "unsupported pending work" — it is a
platform on which C2 is known to be false, and the honest posture is to say so rather than
to leave it looking merely unfinished.

**Scope of the decision, exactly (owner, 2026-08-20).** macOS-only is settled for the whole
pre-1.0 run and for 1.0 itself — it is not a per-release question to be reopened at alpha
or beta, and no release in that window ships a Windows desktop build. **Windows desktop is
reconsidered post-1.0**, as its own decision with its own ADR. Stating the window matters
because "macOS-only at 1.0" alone reads as a fact about one release that someone could
reasonably relitigate at each milestone; it is not. What is deferred is the reconsideration,
not the constraint.

**This decision is a claim about what we ship, and it is currently enforced by
documentation alone.** Recorded plainly because the threat model must not overstate it:

- `tauri.conf.json` still carries `"targets": "all"` and ships `icons/icon.ico`, so
  `pnpm --filter desktop bundle` on a Windows host still produces an artifact. Nothing in
  the build refuses.
- The only mechanism that would catch a Windows regression is the CI gate's Windows leg
  staying red for the right reason — and CI has been billing-blocked since ~2026-08-18,
  failing in ~2s with zero steps. A red X from billing is visually indistinguishable from
  a red X from R-5.

Both are stated as residuals in `docs/threat-model.md` rather than papered over. Closing
them (a build-target restriction with a test pinning it, mirroring
`netTransportCapability.test.ts`'s discipline) is queued in next-steps, not done here: this
task documents the system as built, and a build-config change is its own task with its own
tier.

**Consequences.** The Windows gate leg stays red for the entire pre-1.0 run and must NOT be
softened — the `keyReachable` conjunction is the only check that reasons about key
reachability rather than transport presence, and a leg that is *expected* to stay red for
a year is exactly the kind that erodes by someone "fixing the failing job". The Electron
fallback stays available on its pre-committed terms (the platform seams are shell-agnostic;
the fallback swaps the shell folder, not the architecture).

**Revisit: post-1.0, as its own ADR.** Not before, and not automatically even then — a
wry fix landing mid-beta does not reopen this by itself, because shipping a second desktop
platform is a support-surface decision as much as a security one. The technical
preconditions for a Windows build to be *possible* are: wry honoring `for_main_frame_only`
on WebView2 (or an equivalent SDK-level off-switch), plus a green Windows leg of the
in-shell hard gate, plus `cdp_jwt`'s native-ECDSA requirement verified there — that last
one is separately unverified on Windows and is easy to forget behind the louder R-5.

## Alternatives considered

- **Posture as a persisted requirement seat.** Rejected: `connectionRequirementSchema` is strict-object + https-only by design; a posture seat would force protocol schema change, spec-sync, re-approval churn, and admission/borrow-ban surface — for data that is only a transport hint the registry can serve.
- **Embedded-webview login.** Rejected outright: RFC 8252, `disallowed_useragent`, password-manager loss.
- **Hand-rolled Rust loopback listener.** Rejected for v1: `tauri-plugin-oauth` already provides fixed-port-no-fallback + custom response page; less unreviewed listener code on a credential-adjacent path.
- **Public CORS proxy / disabling webview security for LAN reach.** Refused (same refusals as the 2026-08-12 advisory).
- **Electron.** Held as the explicit fallback if WebKitGTK/WKWebView structurally breaks the C2 gate — the platform seams are shell-agnostic by construction, so the fallback swaps the shell folder, not the architecture.

## Consequences

- The wizard can promise what it renders: each posture carries its own registration walkthrough, and unsupported postures refuse before credentials — provider capability drift becomes a registry PR, not a runtime surprise.
- The fixed port 41420 becomes a small public contract for BYO-registration walkthroughs; changing it invalidates users' registered redirect URIs (documented in the registry instructions).
- A local malicious process can hit the loopback listener; the delivered `code`/`state` are useless without the HMAC state key and PKCE verifier that never leave the user file/host page — same custody story as the web popup, now with an OS-level surface noted in the desktop threat-model delta.
- The LAN http widening is the first scheme-policy fork between platforms; it is keyed to the strong-reviewed host ceiling and covered by negative tests both ways, and it is the precedent boundary: any further widening needs its own ADR.
- Desktop persistence quality (real file, atomic writes) becomes the reference implementation for future non-browser hosts.
