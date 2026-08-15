# Threat-model delta — Desktop-aware dynamic auth (signing, query credentials, LAN devices)

- **Task:** TASK-20260812-desktop-auth-awareness · **ADRs:** [0022](../decisions/0022-registry-request-seats.md) (registry request seats, host-side signing, auth-shaped failure surfacing) · [0023](../decisions/0023-lan-class-providers.md) (LAN-class providers) · amends the desktop-shell delta ([threat-model-delta-desktop-shell.md](./threat-model-delta-desktop-shell.md))
- **Date:** 2026-08-13 · **Status:** the honest delta at task close (P6 whole-surface review).
- **Scope:** what THIS task adds to the attack surface, what bounds each addition, and what is **accepted and not mitigated**. §6 is the ship list.

> **How to read this.** A *delta*, not a full threat model. It assumes the two predecessors:
> the Dynamic Auth v2 delta (LLM-authored templates, the frozen ceiling, the scrubber's
> documented boundary) and the desktop-shell delta (IPC scope, native fetch, the LAN rung).
> Where a residual here is a RESTATEMENT of one of theirs rather than a new one, this
> document says so — a delta that re-sells an inherited residual as new is as misleading as
> one that hides it.

---

## 1. The posture change in one sentence

The host gained the ability to **compute** a credential (sign a JWT), to **place** a
credential somewhere the scrubber's exact-substring model does not fully cover (a URL query
string), and to **trust a device on the user's own network** on the strength of a
first-contact certificate. All three are new *channels* for C1 (credential custody); none
is a new *policy*. The registry remains the only reviewed authority for where a credential
goes, and the frozen per-connection host ceiling remains the wall.

---

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **`cdp_jwt` host-side signing** — an EC private key held in `snug_secrets`, imported and ES256-signed **host-page-side, per request** | Read the key out of app/LLM-visible state; get a signature over an attacker-chosen request | The key is a `secret` field: it lives in `snug_secrets` under the ADR-0014 `auth:` namespace, is read by the executor's per-use credential load, and is consumed inside `template-engine.ts` — the same C1 chain every other credential rides. It never enters an iframe payload, an inspector payload, an export, or an error string (the import module deliberately never echoes pasted content — a PEM's "context" IS the secret). The `uri` claim is built from the **live outbound request** (`<METHOD> <host><path>`), so a signature is bound to the request that produced it; `exp = nbf + 120s` bounds replay to a two-minute window. The template is **registry-pinned** and Guard 2b refuses any borrowing channel that authors a `request` seat, so no prompt-injected requirement can aim `cdp_jwt` at a host of its choosing. Per-argument lint is stricter than the generic rule: both arguments must be declared field keys (quoted literals and request tokens refused) — the engine receives resolved values and cannot re-check, so the render gate's lint is the enforcement seat. |
| **S2** | **`queryTemplate`** — credentials rendered into the outbound **URL** | Harvest the credential from anywhere a URL is echoed | Injection happens **after** every gate, into the outbound URL only; the confirm gate captures the PRE-injection URL and the net-result returned to the app is the URL the app asked for. A request seat carrying either template **suppresses the kind default**, so a query credential is never also sent as `X-Api-Key`. The scrub sites are **enumerated, not vibes** (P0 amendment 14): (a) the `NET_FETCH_FAILED` message — previously `request failed: ${err.message}` shipped unscrubbed while fetch errors routinely embed the full URL; (b) the response body/header scrub, whose candidate set now includes rendered query values; (c) the LLM inspector; (d) RunView surfaces. Candidates carry **both** the raw and the percent-encoded form, derived from `URLSearchParams` itself so the two cannot drift (see §3 R-2 and §4). Human review discloses the placement in its own box (see §4 T3-1). |
| **S3** | **LAN rung: TOFU certificate pin** | MITM the bridge; re-point an approved connection at an attacker device | The pin (SHA-256 leaf fingerprint + CN) is captured **inside** a rustls verifier the desktop crate owns — reqwest never exposes the peer cert to callers — during an explicit `mode:'pair'` the user consents to by pressing a physical button on the device. Subsequent traffic runs `mode:'pinned'`, which **requires** a 64-hex pin and refuses any other leaf. Neither absence is a fallback: no `lanFetch` dep → named refusal (never `?? fetchImpl`, which would send a bridge request through the public-root transport); no recorded pin → named refusal (never an accept-invalid-certs call). A **fresh reqwest client per call** is load-bearing, not hygiene: the verifier only runs at handshake, so a pooled connection established under one pin would serve a later call carrying another with no check at all. The pin lives in the connection's dynamic-state KV (`auth:<appId>:<slot>:_connection`, ADR-0014 custody — not a db column), so it is per-connection by construction. |
| **S4** | **Rust host-class check** | Use the pinned-TLS path as a general egress or SSRF primitive | Enforced **in Rust, before a socket opens**: RFC-1918 IPv4 literals only. Loopback, link-local, CGNAT, public literals, DNS names, IPv6 in both spellings, and leading-zero octal forms all refused. `Policy::none()` unconditionally (no redirect follow); the 1 MiB cap is enforced on the **stream** before bytes cross IPC. An unknown `mode` is an ERROR, never defaulted to the "safer" one — defaulting would either grant pair-mode trust to a typo or produce a pinned refusal the caller cannot explain. Plain http to a private literal still refuses on this path: the executor routes to `lanFetch` only when `lanPrivateHost && url.protocol === 'https:'`, leaving ADR-0021's http-for-private-literals rung intact for LAN devices that serve no TLS at all. |
| **S5** | **The `lan_fetch` IPC surface** | Invoke it from a sandboxed app iframe (C2) | Capabilities stay main-window-only, as for every other command. The gate carries a **per-command** check (`ipc-lan-fetch-refused` with its own callback slot in `IPC_CHECK_IDS`), so a refusal proven for `write_user_file` can never be credited to `lan_fetch` — pinned by a test that drives exactly that borrowed-evidence case. That sensor is honestly **weaker** than the sentinel and says so in its own detail string: `lan_fetch`'s effect is a request to a private IP and the Rust host-class check refuses every address a CI runner can bind, so there is nowhere for a "did it fire?" listener to sit. It vouches only alongside the three key-absence checks, and every "cannot tell" input FAILS. |
| **S6** | **Per-command unreachability drift** | Ship a new command and inherit the family's proof | Same mechanism as S5, stated as a standing rule: the IPC gate identifies commands individually. A new command with no check of its own is unproven, not covered. |
| **S7** | **Auth-shaped failure observer** | Use the observer as an oracle, or leak through it | Host-only callback carrying `(appId, slot, status)` plus, since TASK-20260815 AC4 (ADR-0028 era), an optional `detail`: a ≤160-char plain-text extract of the provider's error reason, read from the **gate-10-scrubbed, size-capped delivered body only** — never the raw `Response`, so every injected-credential form (raw and percent-encoded) is already scrubbed before extraction, pinned by a query-credential echo test. No credentials, no URLs, no raw response bytes; recognized JSON error shapes or a text head only (HTML and unrecognized JSON yield nothing). Rendered by `AuthRepairBanner` as plain text — markup never becomes elements, URLs never become links (hostile-copy test, same rule as registration steps). Fires only on the **final delivered result** of `execute()`, so a 401 cured by the OAuth refresh retry fires nothing; `executeConnectionTestRequest` strips the seat entirely so wizard probes never fire it. The app-visible result is unchanged (`ok:true`, status as-is) — the app contract is not broken to gain visibility. Clean bill issued at the P0 security lens; re-reviewed at the TASK-20260815 plan review (the three "no response bytes" doctrine comments were rewritten with the code in one commit). |

---

## 3. Residual risk — accepted and NOT mitigated

### R-1 — A compromised host page can sign arbitrary CDP requests for the key's lifetime

`cdp_jwt` mints per request from the live key. An attacker who controls the **host page**
(not the app iframe — that is C2 and is unchanged) can therefore obtain signatures for any
request to an approved Coinbase host, and can read the key itself. This is not a new
ceiling: the host page is already the seat that holds every credential and calls fetch, so
host-page compromise has always meant total credential compromise. What `cdp_jwt` changes is
that the *capability* is now expressible without exfiltrating a static secret — a signature
is enough for two minutes.

**Bounded by:** the C1 chain itself (key never crosses into iframe/LLM/export), the pinned
template (no borrowing channel may aim it), and the frozen host ceiling (the `uri` claim is
built from a request that already passed the ceiling check). **Accepted.**

### R-2 — Credentials in URLs are outside our control once they leave

Server access logs, forward/reverse proxies, referrer headers, and browser history are
**not surfaces we own**. A `queryTemplate` credential is written into a URL and is therefore
recorded wherever the provider and the network record URLs. We scrub every site we own,
enumerated in §2 S2; we cannot scrub theirs.

The **encoding hazard** P6 found is the precise shape of the local half of this, and it is
worth stating because it was live and green: the scrub candidate set carried the RAW rendered
value while the outbound URL carried the **percent-encoded** one, and `scrubAuthValues` is
exact substring — so any credential containing `+`, `/`, `=` or a space (i.e. any base64 key)
leaked verbatim into the app-visible `NET_FETCH_FAILED` message and into echoed bodies. Fixed
by deriving both forms from `URLSearchParams` itself so they cannot drift apart.

The deeper residual is **inherited, not new**: a provider that RE-ENCODES a value (base64,
hex, double-escaping) still defeats an exact-substring scrubber. That is the Dynamic Auth v2
delta's R-2, restated here because `queryTemplate` adds a member to the family, not a new
class. **Accepted; the frozen host ceiling remains the primary wall, as it always was.**

### R-3 — The pairing window: a LAN-local attacker present at first pairing

TOFU means the first certificate seen is the trusted one. An attacker already positioned on
the user's network at the moment of pairing — able to answer at the typed address before the
real bridge does — is pinned instead of the bridge, and every later request is faithfully
delivered to them.

**Not mitigated.** Signify-CA pinning would close it and is **deferred**, for reasons that
are structural rather than lazy: the CA material sits behind a login-gated portal, old bridges
are self-signed and would fail CA validation entirely, and CN == bridgeId still requires the
pairing handshake to learn the bridgeId — so TOFU collects both facts in one step. Queued.

**Bounded by:** the attacker must be LAN-local at that exact moment; the user typed the
address themselves; and once pinned, a *later* MITM fails closed rather than silently
succeeding.

### R-4 — An untrusted IMPORT can carry an attacker's pin and secret under an approved row

Surfaced by the P6 Hue trace. A row arrives by import carrying both a `lanPin` in its
`_connection` KV and a paired secret; if it lands under an approved row, the transport will
faithfully pin-verify against the attacker's certificate.

**This is a PRE-EXISTING property of the import channel, not something this task introduced,
and it GENERALIZES beyond LAN** — the identical shape carries OAuth refresh tokens and API
secrets, which import has always been able to carry. The P0 security lens issued a clean bill
on the specific TOFU-vs-import question on two grounds that still hold: local secrets win the
sync/import merge, and an imported row demotes to `declared` + `imported=1`, so a re-pointed
pin cannot serve traffic without a fresh human re-approval. What P6 adds is the observation
that the general question — *what does an import channel get to say about credential state?* —
deserves its own task and its own decision rather than a per-credential-type answer.
**Queued as its own task; not introduced here.**

### R-5 — Windows is STRUCTURALLY BROKEN for the whole IPC boundary (upgraded 2026-08-13)

**This was "unverified" until the Windows gate leg ran for the first time. It ran, and it
failed — so this is no longer a stated gap, it is a known defect and Windows desktop is
BLOCKED.** Full root-cause with citations:
[`docs/solutions/2026-08-13-webview2-subframe-ipc-injection.md`](../solutions/2026-08-13-webview2-subframe-ipc-injection.md).

Tauri asks for main-frame-only injection of the key-bearing `ipc-protocol.js`
(`tauri-2.11.5/src/manager/webview.rs:159-164,182`), and the invoke key is a **plaintext
literal inside that script** (`scripts/ipc-protocol.js:12`). wry's WebView2 backend
**discards `for_main_frame_only`** (`wry-0.55.1/src/webview2/mod.rs:492-494`; documented at
`src/lib.rs:2494-2496`), while the macOS path honors it
(`src/wkwebview/mod.rs:643-644`). So on Windows the invoke key executes **inside
`sandbox="allow-scripts"` app iframes** — reachable by any app a user runs. No off-switch
exists at the wry, tauri, or WebView2 SDK layer.

This meets **ADR-0021 Decision 8's Electron-fallback trigger on its stated terms** ("a
platform that injects IPC into subframes with no off-switch is structural breakage"). The
gate's failure is correct and must NOT be softened: the `keyReachable` conjunction is the
only check that reasoned about key reachability rather than transport presence, and on
WebView2 that distinction has collapsed. `ipc-invoke-refused` passing proves only that the
key GATE works against a keyless post — it says nothing about a frame that can read the key.

**Disposition:** macOS unaffected (40/40 green, WKWebView honors the flag). No Windows build
has ever been distributed and none may ship in this configuration. `cdp_jwt`'s native-ECDSA
requirement remains separately unverified there. ADR-0021 D8 is now a **live owner decision**
— Electron fallback, macOS-only, or upstream a `for_main_frame_only` fix.

---

## 4. The prompt-injection-to-LAN chain, and what stands in it

The sharpest question this task raises: can a prompt-injected requirement get a credential
onto a device on the user's home network — a router, a NAS, a camera?

The chain and every barrier in it:

1. **The address is user-typed.** The model may identify a provider as LAN-class; it may
   never propose an address. The extract-never-invent rule is restated for static kinds in the
   platform layer's binding copy (P0 amendment 15), and the wizard collects the address in its
   own step.
2. **The review screen names the address in a consent band.** Amendment 15's band keys on the
   **HOST**, never on `lanHost` — the load-bearing choice, because the threat is a
   prompt-injected `api_key` row aimed at a router, which carries no LAN seat and borrows no
   brand. Tested across /8, /12, /16, loopback and link-local, and negatively against a public
   host that merely *looks* private (`192-168-1-1.attacker.example`). It **warns and names the
   address**; it never refuses, because self-hosted services are legitimate.
3. **Approval freezes the ceiling.** A pre-collection LAN row derives an EMPTY ceiling that
   refuses everything — which is why the wizard order collect → approve → freeze → pair is
   binding rather than cosmetic.
4. **Pairing requires a physical act.** For the Hue class, the credential is minted only after
   the user presses a button on the device itself, and the minted key writes straight to
   `snug_secrets`, never into app/LLM-visible state.

**The barrier that carries the most weight is (2), and it is human judgment.** That is the same
trade the Dynamic Auth v2 delta's R-1 names: the review screen is the price of admitting these
seats, and it stops paying the moment the review degrades.

**Which is exactly what P6's BLOCKER was.** `queryTemplate` was wired through schema, Guard 2b,
lint, injection and scrubbing — but **not through the review screen**. Both shipped P4 entries
(openweather, coingecko) were approved with no placement disclosure at all: a secret in a web
address is a different risk story from one in a header, and the human was never told which one
they were approving. Now fixed — query credentials get their own box. The general rule is in the
lessons ledger: **a new placement seat must ride every surface the old seat rides, including the
human review that is the price of admitting it.**

---

## 5. What the ceiling does and does NOT bound (deltas only)

Everything in the Dynamic Auth v2 delta §5 still holds. Two additions:

- **It DOES bound the pinned-TLS path.** Routing to `lanFetch` is decided in the executor at
  gates 4/5, where `lanPrivateHost` is already computed and the ceiling is already known — so
  "pinned path only for RFC-1918 literals inside the ceiling" is enforced where the ceiling is
  known, not re-derived by a platform-level router that would have to reconstruct both facts.
  A public host can never reach the pinned path (negative-tested both ways).
- **It does NOT bound query strings** — it never did, and `queryTemplate` now puts a credential
  in one. See R-2.

---

## 6. Accepted residuals — the ship list

| ID | Residual | Bounded by | Status |
|---|---|---|---|
| **R-1** | Host-page compromise yields CDP signatures (2-min windows) and the key itself | C1 chain · pinned template (no borrowing channel may aim it) · frozen ceiling | **Accept.** Not a new ceiling — host page has always held every credential. |
| **R-2** | Credentials in URLs reach server logs, proxies and history — outside our control; and a provider re-encoding a value still defeats the exact-substring scrubber | enumerated scrub sites (ours) · frozen host ceiling | **Accept.** The re-encoding half is the v2 delta's R-2 **restated**, not new. |
| **R-3** | Pairing-window MITM — a LAN-local attacker present at first pairing is pinned instead of the bridge | attacker must be present at that moment · user-typed address · later MITM fails closed | **Accept.** Signify-CA pinning deferred (gated CA material; old bridges self-signed). Queued. |
| **R-4** | An untrusted import can carry attacker pin + secret under an approved row | local secrets win the merge · imported rows demote to `declared`+`imported=1` → re-approval required | **Accept; PRE-EXISTING and generalizes** beyond LAN to OAuth tokens/API secrets. Queued as its own task. |
| **R-5** | **Windows: the invoke key is injected into sandboxed app iframes (WebView2 ignores `for_main_frame_only`)** | none available — no off-switch at wry, tauri, or SDK layer | **KNOWN DEFECT, Windows desktop BLOCKED.** ADR-0021 D8 trigger met; macOS unaffected. See `solutions/2026-08-13-webview2-subframe-ipc-injection.md`. |

---

## 7. Verification record

- Root suite green **uncached** at close: `npx turbo run test --force` → `Tasks: 21 successful, 21 total` · `Cached: 0 cached, 21 total`.
- `cdp_jwt`: minted JWTs decoded and verified with `crypto.subtle.verify` against an **independent** openssl P-256 fixture public key, plus a tampered-payload negative so the verify is not vacuous. Claim shape pinned by test (header `alg/kid/typ/nonce`; payload `iss/sub/uri/nbf/exp`). SEC1→PKCS#8 wrapping tested against real-format fixture keys; Ed25519 and undecodable PEM produce honest typed errors that never echo key bytes.
- Query credentials: C1 negatives drive a response echoing the credentialed URL in **body and etag** plus a thrown fetch error carrying the URL. The P6 fixture is deliberately **encode-forcing** — the pre-P6 fixture was URL-safe hex and therefore could not exercise the encoding it claimed to guard.
- LAN transport, at the **Rust boundary** (the CI fixture per amendment 13 — the host-class check refuses loopback, so no 127.0.0.1 stub can reach this path; the verifier is fed real `rcgen` DER certs): `a_single_flipped_byte_in_the_pin_refuses`, `pinned_mode_REFUSES_a_different_certificate_on_the_same_address`, `refuses_loopback_link_local_public_names_and_ipv6`, `refuses_plain_http_even_to_a_private_literal`, size cap enforced before IPC. `cargo check --release` run explicitly so the release handler list carrying `lan_fetch` is compiled, not just source-scanned.
- Guards re-proven **through** the LAN path rather than assumed from a shared `init` (the 2026-08-12 flag lesson, whose founding precedent is this transport family): redirecting simulated bridge → `NET_REDIRECT_BLOCKED`; oversized body → `NET_SIZE_EXCEEDED`; denied confirm → nothing sent on either transport; credentialed 401 → the observer still fires.
- Cross-package seam identities asserted (`platform.lanFetch toBe lanFetch`, `platform.lanPair toBe lanPair`) after deletion mutants left every desktop test green twice.
- Pairing custody: the minted key writes straight to `snug_secrets`; the exchange response never enters app-, LLM- or export-visible state (C1 negative).
- **Owner manual verification against a real bridge is AC7's closing step and is NOT covered here** — the procedure is at the top of the task file. No test depends on real hardware.
