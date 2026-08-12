# TASK-20260812-desktop-hub-scaffold: Tauri 2 Desktop Hub (roadmap A6, pulled forward to Alpha)

- **Status**: draft
- **Owner**: jeetu (autonomous session, owner-directed: "autonomously complete the whole desktop client using dynamic workflow")
- **Risk tier**: **high** — touches `packages/auth` (new OAuth transports), registry auth surfaces, and the C2 gate must be re-proven inside a new shell; protocol/auth auto-escalate
- **Branch**: `feat/TASK-20260812-desktop-hub-scaffold`
- **Packages touched**: `apps/desktop` (NEW), `apps/playground` (platform seam wiring), `packages/auth` (desktop RedirectUriProvider/CallbackSink impls), registry data (+ `desktopRedirectPosture`, `browserCallable`), `packages/db` (file persistence backend, if backend seam lives there), docs
- **Spec impact**: none on wire protocol v1. Registry entry schema gains reviewed data fields (`desktopRedirectPosture`, `browserCallable`) — internal draft surface, not `snugprotocol/spec`; spec-sync check at plan time
- **Related**: roadmap A6 (`internal/07-roadmap.md`), ADR-0013 (static hub — desktop wraps the same static client), ADR-0014 (credentials local-first), ADR-0016/0017/0020 (connection trust ladder / requirement+grant / multi-option auth), next-steps 2026-08-12 BYOK CORS advisory (desktop native fetch is its rung 2; `browserCallable` disclosure flag proposed there)

## Spec (what & why)

Wrap the existing static hub client (playground) in a **Tauri 2** native shell at `apps/desktop`, making Snug a downloadable desktop app a non-technical user ("grandma") can install and use with connected apps. Desktop is the launch-day artifact for LAN-class connectors (Hue) and kills the BYOK CORS wall via a native fetch behind the existing `fetchImpl` seam — zero security-model change (C1/C2 intact; the app iframe still has `connect-src 'none'`; the host page is the only fetch caller). **BYOK/Local modes only** — no subscription mode in the desktop shell (consistent with ADR-0013 posture for the hosted instance).

Scope pillars:
1. **Native fetch proxy** behind the connected-fetch `fetchImpl` seam — no CORS wall, LAN-reachable (Hue-class), SSRF/host-ceiling guards preserved (host-side checks stay; the browser's CORS was never the security boundary — the executor's allowlist is).
2. **File-backed userdb at `~/Snug`** via the persistence-backend seam — sql.js bytes persisted to a real `user.sqlite` file (A/B-slot safe-write pattern carried over); OPFS remains the web path, untouched.
3. **Ollama autodetect** via the existing local adapter (probe localhost:11434, offer local mode when present).
4. **`.snug` file association** — double-click imports/opens.
5. **Desktop OAuth transports** via the existing `RedirectUriProvider`/`CallbackSink` seams: loopback listener default (fixed port for exact-match providers — Spotify: explicit `127.0.0.1`, never `localhost`; ephemeral for Google-class), with the four-rung ladder (loopback / custom-scheme deep link / hosted https-bridge / device-flow) mapped per provider. Flow logic, HMAC-signed state, flowId binding, PKCE all carry over untouched. **Provider logins open in the SYSTEM browser only (RFC 8252)** — never in the webview (Google blocks embedded webviews, `disallowed_useragent`).
6. **Registry: per-entry desktop redirect posture** — a human-authored, dashboard-verified `desktopRedirectPosture` field (`loopback | loopback-fixed-port | custom-scheme | https-bridge | device-flow`) plus a `browserCallable` disclosure flag, so the wizard renders the right registration walkthrough per platform and **refuses honestly at connect time** instead of failing mid-flow. Provider capability differences become reviewed registry data — the registry is the authority (consistent with TASK-20260812-registry-authoritative-auth).
7. **UI/UX**: grandma-simple, Jony-Ive-calibre intuitive. Wizard walkthroughs per posture; desktop-only affordances labeled; no jargon on the happy path.

**HARD GATE (before desktop is called first-class):** the runner C2 CSP/sandbox suites and one connection-wizard e2e journey must pass **inside the shell** on macOS + Windows (Linux/WebKitGTK best-effort per roadmap B3). If WebKit breaks something structural, fall back to Electron **through the same seams**. (This session can execute the macOS leg; Windows leg runs in CI or is explicitly journaled as pending owner hardware.)

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — fetchImpl seam carries the desktop fetch**: with a desktop platform fetch injected, connected-fetch requests execute through it (not page `fetch`), and all existing executor guards (host ceiling, SSRF policy as applicable to desktop, strict injection, response scrubbing) still run — proven by unit tests over the seam + at least one in-shell probe against a CORS-hostile endpoint that fails in the browser and succeeds in the shell.
2. **AC2 — file-backed userdb**: desktop persistence backend writes `~/Snug/user.sqlite` bytes via safe-write (new-file + atomic pointer/rename, magic check on read; zero-byte/magic-less read = CORRUPT/quarantine, never "fresh"); survives kill-mid-write (crash-safety test at the backend level); web OPFS path unchanged (regression: existing db suites green).
3. **AC3 — Ollama autodetect**: when an Ollama endpoint responds on localhost, desktop boot surfaces local mode with detected models; when absent, no error surfaces and BYOK remains default. Unit-tested probe logic; manual in-shell verification journaled.
4. **AC4 — `.snug` association**: opening a `.snug` file (double-click / Open With) routes into the existing import flow — macOS `RunEvent::Opened` and Windows argv paths both handled; unit-test the routing seam, in-shell manual proof journaled.
5. **AC5 — desktop OAuth loopback**: a full PKCE flow completes with the loopback CallbackSink — `RedirectUriProvider` yields `http://127.0.0.1:{port}/callback` (fixed port for `loopback-fixed-port` entries, ephemeral otherwise; NEVER `localhost`); state/flowId/PKCE assertions carry over; the login URL is opened via the system-browser opener (asserted — no webview navigation). Negative test: callback with wrong/forged state is rejected (existing HMAC guards exercised through the new sink).
6. **AC6 — registry posture is authoritative + honest refusal**: every OAuth-capable registry entry carries a valid `desktopRedirectPosture`; schema validation rejects unknown values; the wizard (a) renders the posture-matched walkthrough, (b) at connect time on desktop, an entry whose posture is unsupported by the running shell build (e.g. `https-bridge` before the bridge ships) gets a clear refusal screen BEFORE credentials are pasted — never a mid-flow failure. `browserCallable: false` entries disclose "this provider can't be called from a browser" in the web wizard (advisory's disclosure) and are callable on desktop.
7. **AC7 — C2 inside the shell (HARD GATE)**: the runner CSP/sandbox suites pass against the webview inside the Tauri shell on macOS (this session) — `allow-scripts` only, `connect-src` blocked from the app iframe, CDN allowlist enforced, enforcement-signal assertions (not API return values). Windows run wired into CI or journaled as pending.
8. **AC8 — wizard e2e inside the shell**: one connection-wizard journey (api-key-class starter connect) passes inside the shell.
9. **AC9 — C1 unchanged**: desktop introduces no new credential egress — tokens still live only in the user file's `snug_secrets`; the loopback listener response page contains no token material (the sink receives only `code`+`state`; exchange happens in the host); no secrets in Rust-side logs. Negative tests at the sink boundary.
10. **AC10 — no-regression**: full root suite (turbo, uncached) green; web playground behavior unchanged when no desktop platform is injected.

**Out of scope**: subscription mode in the shell; the hosted https-bridge page itself (posture value + refusal path ship now; CF Pages bridge is its own task); device-flow implementation (posture value reserved; refusal path covers it); auto-update/signing/notarization + installers for distribution (dev-build proof only this task); Linux first-class support (best-effort); OAuth popup web-path changes; MCP bridge; iOS/Android.

## Plan

(Being written after seam recon — see Session journal. Filled in below before any implementation.)

## Decisions & surprises

- 2026-08-12 — Owner directive in the task brief: autonomous end-to-end completion via dynamic workflows; interview answers embedded in the brief (BYOK/local only; grandma-grade UX; posture-as-registry-data; RFC 8252 hard rule; Electron fallback only if WebKit structurally breaks the gate).
- 2026-08-12 — Toolchain reality: this Mac has rustup under Rosetta (x86_64) with stable 1.76; Tauri 2 needs ≥1.77.2 — toolchain update required before shell build (recorded so the step is explicit, not incidental).

## Session journal (append-only, newest last)

### 2026-08-12 — claude (autonomous) — session start
- Done: repo state verified (main clean at 158c78d, #40 merged); process docs + architecture + lessons read; 3 seam-recon Explore agents + 1 Tauri-facts web-research agent dispatched; spec drafted.
- State: awaiting recon reports; plan section next.
- Next step: write plan into this file, branch, fresh-context plan review (High tier), then TDD phases via workflows.
- Open questions: Windows-leg execution (no Windows hardware in this session — CI matrix or journaled pending); fixed-port number choice for Spotify-class (pick + document collision behavior).
