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
2. **Resolution happens in the executor — after shape validation, before the URL
   gates — and every gate still runs on the resolved URL, against ONE row read.**
   Resolution sits after gate 1 (the 4096-char bound and typing must precede any DB
   read) and before the URL-parse/scheme gates. `connectedFetch` resolves the slot
   against the CALLING APP's own connection rows: unknown slot →
   `NET_INVALID_REQUEST`; row exists but is not approved → `NET_NOT_APPROVED`; ceiling
   holds anything but exactly ONE host → `NET_AMBIGUOUS_CONNECTION` (a symbolic
   address must have exactly one meaning). The resolved URL is
   `https://<ceiling-host><pathAndQuery>`, is re-parsed, and its host must match the
   ceiling host via the CANONICAL comparison (`normalizeAuthHost`/`isHostAllowed` —
   `new URL()` lowercases and punycodes, so raw string equality would false-refuse) —
   then the ENTIRE existing pipeline runs on it: scheme/host/SSRF gates, the confirm
   gate, credential injection, the pinned LAN lane (gate 9a), size caps, scrub.
   `resolveGrant` RE-RUNS on the resolved host — the imported-row gate and the
   two-slot ambiguity gate are retained, and same-row injection is structural rather
   than assumed: the resolving slot's approved row must be among the host matches, so
   a unique match IS that row. **Fail-closed corollary, decided here: when TWO
   approved slots claim the resolved host, the request refuses with
   `NET_AMBIGUOUS_CONNECTION` even though the symbolic URL named one of them** — the
   slot name selects a ceiling to translate through, never a tiebreak for credential
   routing (the same doctrine as the existing host-routing refusal). One
   `listConnections` read is threaded through both resolution and `resolveGrant`, so
   no TOCTOU exists between the row that resolved and the row that injects.
   Resolution grants nothing; it only translates.
3. **The disclosure boundary is the REQUEST, and the mechanism is named, not assumed.**
   The app never receives the host: not in a hook, not in an event, not in an error
   message. The Gate-2 review found the draft leaned on a URL scrub that does not
   exist (the auth scrubber redacts credential VALUES only) while two live paths
   interpolated the host into app-facing messages — so the mechanism is explicit: for
   symbolic-origin requests, the resolved host and href join the scrub candidate set,
   AND the host-bearing refusal messages on the symbolic path are genericized (the
   gate-5 SSRF refusal, the routing-ambiguity message, and transport `err.message`
   passthrough). On WEB — where no transport policy admits private hosts — a symbolic
   request resolving to a private host refuses at gate 5 as today (`NET_SSRF_BLOCKED`)
   with a host-clean message; consumers treat it as "unreachable from here". What this
   ADR does NOT claim: response BODIES are scrubbed only for credentials, as before —
   a device that echoes its own address in a payload is visible to the app that asked.
   That is the provider's data surface, not a new host-side disclosure, and scrubbing
   arbitrary private-IP shapes out of JSON would corrupt legitimate payloads. The
   USER, by contrast, sees the truth the app cannot: the confirm dialog for a symbolic
   write names the RESOLVED host.
4. **Probe-on-load is the connection-status mechanism at v1.** The read an app must
   make anyway IS the signal: success means connected; `NET_NOT_APPROVED` means "offer
   the connect CTA"; transport-shaped failures mean "unreachable from here" (which is
   also the honest web answer — the pinned LAN lane is desktop-only). No new frames.
   The `hostEvent` namespace stays open for a future live status event; nothing here
   precludes it.
5. **Scope: single-host HTTPS connections, own-app slots only.** The scheme works for
   any approved single-host connection (not LAN-specific — the generalization is
   free), and only for slots the calling app itself declared; the slot grammar is
   `CONNECTION_SLOT_RULE`, imported rather than restated, so an addressable slot is by
   definition a declarable one. Multi-host resolution semantics are deliberately
   refused rather than invented. One honest carve-out (Gate-2 review): the resolved
   scheme is hardcoded `https`, so ADR-0021's http-to-private-literal rung is NOT
   reachable symbolically — a plain-http device would resolve to `https://` and refuse
   at the pinned lane's scheme condition. If that device class ever ships, symbolic
   addressing for it is a new decision, not a silent widening.

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
