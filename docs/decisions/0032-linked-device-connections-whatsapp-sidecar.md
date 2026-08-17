# 0032 — Linked-device connections: the `linked_device` auth kind, loopback sidecar class, and WhatsApp Personal

- **Status:** accepted (2026-08-17, ships with TASK-20260816-whatsapp-twin; the Gate-2 plan review and a dedicated adversarial review returned five blockers BEFORE implementation, and §4 below is the rewrite that came out of them — the original loopback-class draft was withdrawn as UNSAFE and, as B5 established, literally unstorable. Threat surface: `docs/security/threat-model-delta-whatsapp-sidecar.md`)
- **Date:** 2026-08-16
- **Task:** TASK-20260816-whatsapp-twin

## Context

Some providers authenticate a *device*, not a request: personal WhatsApp links a companion
device by QR scan, after which the session lives in long-lived Signal/noise key material and
a persistent WebSocket — no API key to type, no OAuth to redirect, and a runtime the
sandboxed iframe (C2) and the request/response connected-fetch executor structurally cannot
host. The existing kinds (ADR-0020's registry-declared set) and the LAN class (ADR-0023)
cover typed secrets, OAuth, and pairing-minted keys on RFC-1918 devices — none covers a
linked-device session. The owner also wants the auth experience registry-consistent so every
user-authored WhatsApp app gets the same wizard (2026-08-16 interview).

## Decision

1. **Sidecar runtime.** A repo package `apps/whatsapp-sidecar` (Node + Baileys) owns the
   linked-device session: WebSocket, history sync, send. It serves a loopback-only HTTP API
   (binds 127.0.0.1, never 0.0.0.0). The desktop shell may spawn/supervise it; it is **LLM-free**
   — every analysis/compose turn runs in the governed host (the "LLM calls originate from the
   host page only" invariant), so the sidecar is transport + custody, never a second brain.
2. **Credential custody split (C1).** WhatsApp session keys live ONLY in the sidecar's disk
   store (Baileys' `useMultiFileAuthState`) and are serialized on no HTTP route. What enters
   `snug_secrets` is a **sidecar access token** minted exactly once at pairing (the Hue
   shape: exchange → minted secret → header injection), ≥256 bits of CSPRNG entropy,
   required on **every** route. Pairing completes only when the sidecar is handed the
   spawn-time nonce by `sidecar_ctl`, so a process that wins the bind race on the port
   cannot mint itself into the sidecar's position — loopback has no TLS pin to fall back on.
3. **`linked_device` kind.** `connection-requirement` gains the kind; registry entries of this
   kind carry pairing seats (start → QR render → linked-status poll → **verify-before-claim**
   per ADR-0025) and a `headerTemplate` injecting the minted token. Admission stays
   kind-agnostic (D6 pin intact); the wizard forks on kind for UX only (QR screen + poll).
4. **The sidecar is a capability, not a host** (rewritten 2026-08-16 after the Gate-2
   adversarial review returned UNSAFE on the original loopback-class draft; see the task
   file's B1/B3/B5). No `lanHost` class is added and **no loopback host ever enters a frozen
   ceiling**. Reachability is a dedicated Tauri command, `sidecar_fetch`, built on the
   `lan_fetch` template — enforcing in Rust, before a socket opens: METHOD and PATH against
   the enumerated contract, traversal checked on the DECODED form, and a response cap
   enforced while reading. `/pair/*` and `/session/*` are reachable from the wizard only,
   never from an app. `isForbiddenNetHost`'s unconditional loopback refusal,
   `transportPolicy`, and the desktop capability belt are all left untouched.

   **The transport is a UNIX-DOMAIN SOCKET, not TCP** (owner decision, 2026-08-16, folded in
   before implementation; the Phase-C "open" item below is thereby closed). The helper
   listens on `~/Snug/whatsapp-sidecar.sock` at `0600`, created by `sidecar_ctl`. This is
   strictly stronger than the TCP design AND simpler: there is no port to race for, so port
   squatting becomes unrepresentable rather than mitigated, and filesystem permissions — not
   bind order — decide who may connect. Admission needs no host check and no port check
   because there is no TCP endpoint at all; nothing on the machine's network stack can reach
   the helper. The spawn nonce survives as defense in depth. Windows: a named pipe with an
   equivalent DACL is the twin, authored behind the same seam but gated red with the rest of
   the D8 story (ADR-0021) rather than faked green.

   *Why the original draft was wrong, recorded so it is not re-proposed:* the frozen ceiling
   is host-granular with no port dimension (`app-host-freeze.ts:24-27` compares
   `new URL(url).hostname`), and `CONNECTION_HOST_RULE` (LDH-only) plus `normalizeAuthHost`
   (requires an empty port) make `127.0.0.1:8787` **unstorable**. The only representable
   ceiling entry, `127.0.0.1`, would have granted every loopback port on the machine —
   Docker's TCP socket, Ollama, database admin surfaces, Jupyter kernels, another app's
   sidecar — over a path with no Rust-side host gate and no TLS pin, i.e. strictly weaker
   than the RFC-1918 rung it cited as precedent. Adding a `lanHost` seat would additionally
   have routed the row into hue's pinned-TLS pairing path (`isLanRequirement` is
   `lanHost !== undefined`, 13 call sites), which demands a 64-hex certificate pin that a
   plain-http loopback sidecar can never produce.
5. **ToS honesty.** Unofficial WhatsApp automation violates WhatsApp's ToS; account bans
   happen. The wizard consent copy and the starter README state this plainly; pacing/rate
   guardrails (ADR-0033) are mitigation, never detection evasion.

## Alternatives considered

- **whatsapp-web.js (Puppeteer/Chromium)** — heavier runtime, a whole browser as a sidecar;
  Baileys speaks the protocol directly over WebSocket.
- **Embed the session in the Tauri shell (Rust)** — strongest always-on story, heaviest build,
  couples a ToS-gray subsystem into the shell while ADR-0021 D8 is still open.
- **Sidecar holds an LLM key and auto-replies autonomously** — rejected: breaks the host-only
  LLM invariant and moves persona data + credentials outside every governed surface.
- **Model as api_key with lanHost only (no new kind)** — smaller schema delta, but the wizard
  cannot render a QR/poll flow generically and "consistent wizard for similar apps" fails.

## Consequences

- First sidecar precedent (the BYOK CORS relay thread can reuse the pattern) — and it
  establishes that a locally-spawned helper is reached by a **purpose-built Rust command**,
  not by widening the host ceiling. New threat-delta doc: session-key custody, port-squatting
  residual, pairing-window residual, ToS/ban residual, impersonation-consent residual, and —
  distinct from impersonation — a **third-party-consent residual**: the analysed group
  members never consented and are not Snug users, and under BYOK their messages reach the
  user's configured model provider.
- ~~Open (Phase C): a unix-domain socket instead of TCP~~ — **DECIDED and shipped** (owner,
  2026-08-16): UDS, folded into §4 above before any transport code was written.
- Spec impact stays internal-draft (connection-requirement is outside `schemas/` sources), with
  spec-changelog + staged-draft notes per SPEC_SYNC.
- The desktop `sidecar_ctl` IPC command joins the C2 gate scope (IPC unreachable from iframes).
