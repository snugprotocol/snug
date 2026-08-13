# 0023 — LAN-class providers: user-supplied bridge hosts, pairing exchanges, scoped TLS trust

- **Status:** accepted (2026-08-13, at the close of TASK-20260812-desktop-auth-awareness). The P0 and P6 amendments are folded in-file above — this document is the shipped decision, not the draft.
- **Date:** 2026-08-12
- **Task:** TASK-20260812-desktop-auth-awareness

## Context

ADR-0021 Decision 4 opened the desktop transport rung — `http(s)` to RFC-1918 IPv4
literal hosts the user explicitly approved into a connection's frozen ceiling — but no
**declaration path** exists to put a LAN device behind a connection row:

- The registry's structural rule requires every entry to pin a non-empty, human-reviewed
  `apiHosts` list; a Hue bridge lives at a user-specific private IP that cannot be pinned.
- Philips Hue CLIP v2 is **https-only** on the bridge, serving a certificate with
  CN = bridgeId signed by Signify's private CA (self-signed on old firmware) — native
  fetch refuses it, and no per-host trust mechanism exists.
- The credential is **minted, not typed**: press the link button, then
  `POST https://<bridge>/api {"devicetype":…,"generateclientkey":true}` returns the
  application key (+ Entertainment `clientkey`). No wizard flow models a pairing exchange.
- Discovery (`discovery.meethue.com`) CORS-locks to its own origin — desktop-only; mDNS
  is unavailable in the webview.

## Decision

1. **`lanHost` seat instead of pinned hosts.** A LAN-class registry entry declares
   `lanHost: { class: 'rfc1918-ipv4-literal', label }` and NO `apiHosts`; the structural
   rule becomes "pinned `apiHosts` XOR `lanHost`". The wizard collects the bridge IP,
   validates the class (RFC-1918 IPv4 literal only — loopback/link-local/DNS names/IPv6
   refused), and writes it into `declaredApiHosts`, freezing it into the ceiling like any
   other host. Rows stay platform-portable: on web the wizard **discloses** "needs the
   desktop app" (the `disclosedBrowserWall` pattern) and the executor's existing gates
   keep refusing; nothing platform-conditional persists (consistent with ADR-0021's
   "posture is never a requirement seat").
   **P0 amendment (binding — lan-schema-2):** this is a **protocol schema change**, not
   just a registry-type change: `declaredApiHostsSchema` is `.min(1)` and required, so a
   pre-collection LAN requirement cannot parse. `connectionRequirementSchema` gains an
   optional `lanHost` seat with declaredApiHosts required-XOR-lanHost (superRefine);
   `requirementFromRegistryEntry`, admission, and the borrow-ban host trigger fork with
   it; SPEC_SYNC staged draft + spec-changelog updated; the schema fork joins the task's
   AC9 fence list.
   **P0 round-2 amendment (binding — lan-admission-clobber; probe-verified):** the
   admission fork's SEMANTICS: (a) `registryHostIndex` skips lanHost entries — without
   this, one apiHosts-less entry makes every admission of any requirement throw
   TypeError on the fail-closed path; (b) `applyRegistryValues` PRESERVES the
   declaration's declaredApiHosts for lanHost entries instead of substituting (today it
   unconditionally rewrites hosts on every borrow hit, which would wipe the user's
   bridge IP), and admission re-validates the RFC-1918-IPv4-literal class so a borrower
   cannot smuggle a public host under the hue brand; (c) this is a deliberate carve-out
   of ADR-0020 Decision 4's "hosts are ALWAYS the entry's on every option path"
   invariant, scoped to lanHost entries only, recorded here (decisions are append-only —
   ADR-0020 itself is not edited). Negative tests: hue borrow keeps the IP; hue + public
   declared host refused; non-hue admission unaffected by the hue entry's presence.
2. **Pairing is a wizard-run, host-side credential exchange** described by a registry
   `pairing` seat (Hue: the link-button POST above; response field → secret). The minted
   key writes **directly to `snug_secrets`**; the exchange response never enters app-,
   LLM-, or export-visible state (C1). The model never proposes bridge IPs (the inferrer's
   extract-never-invent rule stands); it may only identify a provider as LAN-class.
   **P0 amendments (binding — pairing-transport-unspecified):** wizard ordering is
   collect IP → approve row → ceiling frozen → THEN pair (pairing always runs against an
   already-frozen ceiling). The pairing POST rides the SAME Rust command in an explicit
   `mode:'pair'` whose rustls verifier **accepts-and-captures** the certificate
   (fingerprint + CN) — reqwest never exposes the peer cert to callers, so capture must
   live inside the verifier — for RFC-1918-IPv4-literal hosts only, validated in Rust,
   returning the pin alongside the response so the wizard writes pin + key in one step.
   Pair mode carries its own enumerated guards (Rust host-class check, response size cap,
   no redirect follow) and is negative-tested unreachable for public hosts and from
   iframes (C2 IPC scope).
3. **Scoped TLS trust, desktop only:** at pairing time the bridge certificate
   (fingerprint + CN) is **TOFU-pinned to the connection** — stored in the connection's
   dynamic-state KV in `snug_secrets` (`auth:<appId>:<slot>:_connection`, ADR-0014
   custody; NOT a new db column). Subsequent requests to RFC-1918-literal ceiling hosts
   route through the same Rust command in `mode:'pinned'`, whose custom verifier enforces
   the pin — code we execute and test, never a transport accept-invalid-certs flag
   (lesson 2026-08-12: a guard expressed as a flag is only as real as the transport's
   willingness to read it). **P0 amendments (binding — lan-pin-plumbing):** the pin
   travels executor→transport via a NEW optional desktop-only dep
   `lanFetch?(url, init, pin)` beside `fetchImpl` in ConnectedFetchDeps (`FetchLike`
   untouched for web); routing is decided IN THE EXECUTOR at gates 4/5, where
   `lanPrivateHost` is already computed — so "pinned path only for RFC-1918 literals
   inside the ceiling" is enforced where the ceiling is known. Rust builds a FRESH
   reqwest client per call (pin baked into the verifier — no client cache or pool reuse
   across pins), installs `Policy::none()` unconditionally, and enforces the 1 MiB cap
   in Rust before bytes cross IPC; both semantics are re-proven by tests (redirecting
   simulated bridge → NET_REDIRECT_BLOCKED, oversized body → NET_SIZE_EXCEEDED). The
   pinned-trust path is structurally unreachable for public hosts (negative-tested both
   ways); public-host behavior stays byte-identical. The pairing-time MITM window is a
   **documented residual** (LAN-local attacker present at first pairing), mitigated later
   by Signify-CA pinning when the gated CA material is obtained — queued, not v1.
4. **Discovery**: a desktop-only "find my bridge" wizard button queries
   `discovery.meethue.com` via native fetch; manual IP entry is the primary path; mDNS
   deferred.

## Alternatives considered

- **Global/per-request accept-invalid-certs** (e.g. plugin `danger` options). Rejected:
  unscoped trust destruction plus the guard-as-flag failure mode — the desktop redirect
  incident proved transport flags cannot be assumed honored.
- **Signify-CA pinning at v1.** Deferred: the CA material lives behind a login-gated
  portal, old bridges are self-signed anyway, and CN==bridgeId still requires the pairing
  handshake to learn the bridgeId — TOFU at pairing collects both facts in one step.
- **Plain http to the bridge.** Rejected: CLIP v2 never supported it. (ADR-0021's
  http-for-private-literals rung remains for other LAN device classes.)
- **Model-inferred bridge IPs.** Rejected: extract-never-invent; a user-specific address
  is structurally unproposable — user entry via the wizard is the honest path.
- **mDNS discovery at v1.** Deferred: needs a Rust-side responder/browser and its own
  review; the cloud broker + manual entry cover the launch story.

## Consequences

- The registry type forks host sourcing (pinned XOR lan) and the structural suites fork
  with it; `hue` becomes the first entry whose credential is minted by an exchange.
- A new Rust surface (`lan_fetch`) joins the C2 gate scope (IPC unreachability from
  iframes) and the desktop threat-model delta gains TOFU-pin and pairing-window sections.
- The wizard grows two reusable pieces: a host-collection step with class validation, and
  a pairing step machine — both designed provider-agnostically for future LAN devices.
- Web behavior for LAN rows is disclosure, never breakage — a desktop-minted user file
  opened on web keeps every row intact.
- **P5 correction (folded, shipped):** `hue.pairing.secretPath` is `[0, 'success',
  'username']` — a CLIP v1 pairing answer is an ARRAY of result objects OUTERMOST, so the
  index comes first. This SUPERSEDES the task file's pinned literal spelling
  (`success[0].username`, ambiguous prose); the shipped path would otherwise have resolved
  to `undefined` on every real bridge response.
- **P6 amendment (folded, shipped):** `migrateConnectionRegistryDrift` resolves the registry
  through `resolveRegistryEntryByName`, not exact-key `lookupWellKnownProvider` — rows
  persist the entry's `displayName`, and `'Philips Hue'` normalizes to `philipshue`, not the
  key `hue`, so seat-drift migration bailed at its first branch for EVERY hue row.
- **Accepted residuals** (pairing-window MITM, untrusted-import pin/secret overwrite —
  pre-existing and generalizing beyond LAN, Windows unverified) are stated in
  [`docs/security/threat-model-delta-desktop-auth.md`](../security/threat-model-delta-desktop-auth.md).
- The Hue starter's apply control stays honestly greyed: **no protocol frame tells an app
  which hosts it may reach**, so a LAN app cannot know its own bridge address. An
  approved-host disclosure frame is the missing piece and is a protocol decision for its own
  task (queued in next-steps), not something a starter may take.
