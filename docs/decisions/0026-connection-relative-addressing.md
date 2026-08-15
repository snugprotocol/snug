# 0026 — Connection-relative addressing: apps name their connection, never its host

- **Status:** proposed (drafted at Gate 2 of TASK-20260814-hue-starter-real-connection; accepted when the owner approves that plan)
- **Date:** 2026-08-14
- **Task:** TASK-20260814-hue-starter-real-connection

## Context

ADR-0023/0025 built and proved the Hue lane end to end — collect, approve, pair,
verify — and the owner has now confirmed it against real hardware. But the app the
connection exists FOR still cannot use it: `useConnectedFetch` takes a LITERAL url, the
executor checks it against the frozen ceiling, and a LAN connection's host is a
router-assigned address only the user knows. A placeholder host does not parse; a
hardcoded one is right for exactly one user; and handing sandboxed app code the user's
home-network layout is a disclosure the starter was never allowed to take unilaterally
(next-steps 2026-08-13 item 1 — this ADR is that queued decision, commissioned by the
owner 2026-08-14 with the stance question answered: the app must NOT learn the IP).

## Decision

1. **A connection-relative URL scheme, protocol-owned.** An app may address its own
   connection symbolically: `snug-connection://<slot><pathAndQuery>` (e.g.
   `snug-connection://hue/clip/v2/resource/room`). The grammar lives in
   `packages/protocol` (scheme constant + one strict parser: slot is
   `[a-z0-9][a-z0-9-]*`, the remainder must begin with a single `/`; anything else is a
   typed parse failure, never a guess). The net-request frame schema is UNCHANGED — its
   `url` was always a bounded string — so this is a contract addition, not a frame
   change; it flows through spec-sync (C3) all the same.
2. **Resolution happens in the executor, before the gates, and every gate still runs.**
   `connectedFetch` resolves the slot against the CALLING APP's own connection rows:
   unknown slot → `NET_INVALID_REQUEST`; row exists but is not approved →
   `NET_NOT_APPROVED`; ceiling holds anything but exactly ONE host →
   `NET_AMBIGUOUS_CONNECTION` (a symbolic address must have exactly one meaning). The
   resolved URL is `https://<ceiling-host><pathAndQuery>`, is re-parsed, and its host
   must equal the ceiling host it was built from (normalization guard against `//`,
   `@`, `\` smuggling) — then the ENTIRE existing pipeline runs on it: scheme/host/SSRF
   gates, the confirm gate, credential injection, the pinned LAN lane (gate 9a), size
   caps, scrub. Resolution grants nothing; it only translates.
3. **The disclosure boundary is the REQUEST, and it is stated honestly.** The app never
   receives the host: not in a hook, not in an event, not in an error message (the
   executor's existing URL scrub covers the resolved form). What this ADR does NOT
   claim: response BODIES are scrubbed only for credentials, as before — a device that
   echoes its own address in a payload is visible to the app that asked. That is the
   provider's data surface, not a new host-side disclosure, and scrubbing arbitrary
   private-IP shapes out of JSON would corrupt legitimate payloads.
4. **Probe-on-load is the connection-status mechanism at v1.** The read an app must
   make anyway IS the signal: success means connected; `NET_NOT_APPROVED` means "offer
   the connect CTA"; transport-shaped failures mean "unreachable from here" (which is
   also the honest web answer — the pinned LAN lane is desktop-only). No new frames.
   The `hostEvent` namespace stays open for a future live status event; nothing here
   precludes it.
5. **Scope: single-host connections, own-app slots only.** The scheme works for any
   approved single-host connection (not LAN-specific — the generalization is free),
   and only for slots the calling app itself declared. Multi-host resolution semantics
   are deliberately refused rather than invented.

## Consequences

- The Hue starter (and any future device/user-host app) can drive its real connection
  with zero knowledge of the user's network — the ceiling remains the single place the
  address lives, and C1/C2 are untouched (credentials still injected host-side; the
  sandbox still has no network of its own).
- `sdk/embedded/snug-hooks.js` documentation and the app-authoring KB teach the scheme
  (lockstep byte-sync across the example apps per the kb-sync rule), so authored apps
  learn to use it instead of inventing hosts — the extract-never-invent rule gains its
  addressing-side twin.
- The literal-URL path is byte-identical for every existing app (regression-pinned).
- `spec-changelog` records the contract addition; the spec repo push follows
  SPEC_SYNC.md and happens only on explicit ask.
