# 0032 — Linked-device connections: the `linked_device` auth kind, loopback sidecar class, and WhatsApp Personal

- **Status:** proposed (drafted at Gate 2 of TASK-20260816-whatsapp-twin; accepted at that task's close if the plan survives review)
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
   store and are serialized on no HTTP route. What enters `snug_secrets` is a **sidecar access
   token** minted exactly once at pairing (the Hue shape: exchange → minted secret → header
   injection), so any local process cannot drive the user's WhatsApp unauthenticated.
3. **`linked_device` kind.** `connection-requirement` gains the kind; registry entries of this
   kind carry pairing seats (start → QR render → linked-status poll → **verify-before-claim**
   per ADR-0025) and a `headerTemplate` injecting the minted token. Admission stays
   kind-agnostic (D6 pin intact); the wizard forks on kind for UX only (QR screen + poll).
4. **Loopback class.** `lanHost` class union gains `'loopback-ipv4-literal'`; the wizard
   pre-fills `127.0.0.1:<port>` (port editable) and freezes it into the ceiling. The executor's
   desktop `transportPolicy` admits plain http to that class's approved ceiling hosts only —
   over `fetchImpl`, NOT `lan_fetch` (no TLS pin exists on loopback). Browser profile stays
   byte-identical; web renders the desktop-only disclosure wall (ADR-0023 pattern).
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

- First loopback-class connection and first sidecar precedent (the BYOK CORS relay thread can
  reuse the pattern). New threat-delta doc: session-key custody, local-process risk → token
  auth, pairing-window residual, ToS/ban residual, impersonation-consent residual.
- Spec impact stays internal-draft (connection-requirement is outside `schemas/` sources), with
  spec-changelog + staged-draft notes per SPEC_SYNC.
- The desktop `sidecar_ctl` IPC command joins the C2 gate scope (IPC unreachable from iframes).
