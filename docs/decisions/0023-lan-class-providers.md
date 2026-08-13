# 0023 — LAN-class providers: user-supplied bridge hosts, pairing exchanges, scoped TLS trust

- **Status:** proposed (P0 draft of TASK-20260812-desktop-auth-awareness; finalize at P5)
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
2. **Pairing is a wizard-run, host-side credential exchange** described by a registry
   `pairing` seat (Hue: the link-button POST above; response field → secret). The minted
   key writes **directly to `snug_secrets`**; the exchange response never enters app-,
   LLM-, or export-visible state (C1). The model never proposes bridge IPs (the inferrer's
   extract-never-invent rule stands); it may only identify a provider as LAN-class.
3. **Scoped TLS trust, desktop only:** at pairing time the bridge certificate
   (fingerprint + CN) is **TOFU-pinned onto the connection row**. Subsequent requests to
   RFC-1918-literal ceiling hosts route through a dedicated Rust `lan_fetch` command
   whose custom verifier enforces the pin — code we execute and test, never a transport
   accept-invalid-certs flag (lessons 2026-08-12: a guard expressed as a flag is only as
   real as the transport's willingness to read it). The pinned-trust path is structurally
   unreachable for public hosts (negative-tested both ways); public-host behavior stays
   byte-identical. The pairing-time MITM window is a **documented residual** (LAN-local
   attacker present at first pairing), mitigated later by Signify-CA pinning when the
   gated CA material is obtained — queued, not v1.
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
