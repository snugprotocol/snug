# Threat-model delta — Desktop shell (Tauri 2)

- **Task:** TASK-20260812-desktop-hub-scaffold · **ADR:** 0021 · **Status:** shipped with the desktop scaffold (draft until task close)
- **Scope:** what the native shell ADDS to the attack surface relative to the browser hub, what defends each addition, and what is **accepted and not mitigated**.

## 1. Posture change

The hub client gains a native process boundary: a Rust host with filesystem access, a native HTTP client, an OS-level loopback listener, and an IPC bridge into the webview. C1 (credential custody) and C2 (app-iframe sandbox) are unchanged **in policy**; every addition below is a new *channel* those policies must survive, not a new policy.

## 2. New surfaces and their defenses

| Surface | What an attacker could try | Defense |
|---|---|---|
| **Tauri IPC bridge** (`invoke`: user-file read/write, opened-file read, export, oauth start/cancel) | A hostile micro app inside the sandboxed iframe invokes `read_user_file` → whole `user.sqlite` incl. `snug_secrets` (C1 break), or native fetch (C2 exfil) | Capabilities scoped to the **main window only** (`capabilities/main.json`); the in-shell hard gate (AC7) asserts IPC handles are unreachable — or invocation refused — **from inside a sandboxed srcdoc iframe**, as an enforcement-signal check on every gated platform. IPC-in-subframes with no off-switch is defined as structural breakage → Electron fallback (ADR-0021 §8). |
| **Loopback OAuth listener** (`127.0.0.1:41420` fixed / ephemeral) | (a) Local process or drive-by page fires forged `code`/`state` at the callback; (b) local process races the REAL redirect, injecting its own authorization code under the **valid** state | (a) dies at HMAC state verify / held `expectedFlowId` / nonce single-use — unchanged guards. (b) is defeated only by provider-side **PKCE challenge binding**, which is why `pkce:false` + loopback posture is refused structurally at registry-test time (ADR-0021 §2); such providers get non-loopback postures (GitHub OAuth-app → device-flow, refused-until-built). |
| **Native fetch (reqwest, CORS-free)** | Widening egress beyond the browser's | The connected-fetch executor remains the only host-side caller; frozen per-connection host ceilings, strict injection, scrubbing all unchanged. The Tauri HTTP capability scope (https + RFC-1918 http) is belt, not policy — same trust position as the browser, where page fetch was also unscoped. |
| **LAN scheme widening** (`transportPolicy.allowHttpForPrivateHosts`, desktop only) | SSRF into the LAN; using Snug as a pivot | Admits **only** RFC-1918 IPv4 **literals** (octet-parsed; 172.16/12 boundary-tested) that the user explicitly approved into the frozen ceiling via the wizard's strong review. Loopback, link-local, `localhost`, `.local`/`.internal`, DNS names, IPv6 all stay refused regardless of policy. Approved private literals are reachable over https as well (host-class-based; Hue v2 speaks https). Browser profile byte-identical to before. |
| **Opened-file path** (`.snug` double-click, second-instance argv) | Argv injection (flag-/URL-shaped), tricking the shell into reading arbitrary files, silent import of a hostile DB | Single-use allowlist admits only *existing files* with `.snug`/`.sqlite` extension that arrived via a real OS open event; `read_opened_file` serves an allowlisted path once; there is **no generic path-read command**. The import itself requires an explicit confirm dialog and routes through `importUserFile`, arming the F15 endpoint-confirm guard (foreign executable config never runs unconfirmed). |
| **Export path** | Webview writes to arbitrary paths | Save dialog and write live in ONE Rust command; the webview supplies bytes + a sanitized *suggested name* only. |
| **User-file commands** | Path traversal via `name` | Bare-filename charset check (no separators, no dotfiles, ≤128 chars); all writes temp+fsync+rename inside `~/Snug`. |
| **crypto.subtle fallback** (installed only when the webview lacks WebCrypto) | A weaker or divergent HMAC/SHA implementation weakens state signing | Pure-JS SHA-256/HMAC pinned byte-for-byte against real WebCrypto vectors incl. RFC 4231; installed only on desktop entry, never web; `getRandomValues` (nonce/verifier entropy) is context-independent and never polyfilled. |
| **Gate-mode host remap** (debug builds) | A strictness knob shipping to users | Compiled under `cfg(debug_assertions)` / DEV-only bundles, active only with `SNUG_SHELL_GATE=1` read once at start; the gate itself asserts the remap is inert without the env and absent from release artifacts. |

## 3. Accepted residuals (not mitigated, by decision)

1. **Authorize-URL visibility to local processes.** The system browser is opened with the URL (incl. `state`) in argv/`ps`-visible form on some platforms. `state` is not a secret against the PKCE-bound code exchange; the residual is local-process flow *disruption*, not credential theft. Accepted — same class as a local process killing the listener.
2. **DNS rebinding for public hostnames.** The LAN policy keys on IP literals, so a public DNS name rebinding to a private IP mid-flight is refused as a *name* only by the existing browser-edition guard; native pin-resolution (resolve-then-connect-by-IP) is deferred — queued in next-steps. The frozen host ceiling still bounds *which names* are reachable at all.
3. **Loopback port squatting.** A local process may pre-bind 41420, DoS-ing fixed-port sign-ins. Surfaced as an honest wizard error naming the port. A squatter receiving the redirect still lacks the PKCE verifier and the HMAC key; accepted as availability-only.
4. **`~/Snug/user.sqlite` is a plaintext file** readable by any process running as the user — exactly the custody ADR-0014 promises (the USER owns the file; OS user-account boundary is the perimeter). Full-disk-encryption and OS keychain wrapping are explicitly out of scope pre-1.0 (KeyProvider/KMS is the roadmap's host-blindness track).
5. **Ollama probe** talks plaintext to `127.0.0.1:11434` outside the connected-fetch guards (it is an LLM adapter surface, not an app connection). Model names are the only data read.

## 4. Verification record

- Registry structural tests: posture presence, loopback⇒PKCE refusal (red-proven), posture-union runtime assertion.
- Transport core: 22 tests (recorded-URI identity across service calls and listener teardown, single-flight, TTL, forged/malformed-state non-delivery, fixed-port bind-failure honesty).
- LAN policy: 17 tests incl. octet boundaries (172.15/172.16/172.31/172.32), policy-absent regression, probe carry-through.
- File backend: 12 tests (absence vs corruption vs rejection; both magics; sidecar round-trip) + 4 Rust tests (traversal refusal, atomic overwrite, no tmp survivors) + single-use allowlist test.
- In-shell hard gate (AC7/AC8): 14 CSP checks + IPC-unreachability checks + wizard journey 1 — results recorded in the task journal per platform.
