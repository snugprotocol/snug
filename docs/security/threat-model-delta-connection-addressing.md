# Threat-model delta — connection-relative addressing (ADR-0026)

- **Task:** TASK-20260814-hue-starter-real-connection
- **Date:** 2026-08-14
- **Surface:** `packages/protocol/src/connection-url.ts` (grammar) + the resolution step
  in `packages/auth/src/connected-fetch.ts` (executor)

## What changed

Sandboxed app code may now write `snug-connection://<slot><pathAndQuery>` instead of a
literal URL. The executor resolves the slot — the CALLING APP's own declared connection,
approved, with exactly one frozen-ceiling host — to `https://<host><pathAndQuery>` and
runs the ENTIRE pre-existing gate pipeline on the result. No frame schema changed; no new
capability was granted. The sandbox gains a new SPELLING for a request class it could
already make if it knew the host — the change is that it no longer needs to know it.

## Invariants preserved (and how)

- **C1 (token boundary):** untouched. Injection, header stripping, response scrub and
  the confirm gate all run on the resolved URL through the unchanged pipeline. The
  symbolic path adds no credential surface.
- **C2 (sandbox integrity):** untouched — no iframe, CSP or frame-boundary change. The
  runner routes the frame without parsing the URL.
- **Ceiling authority:** resolution can only ever produce a host FROM the frozen
  ceiling, and the resolved URL is re-parsed with a canonical host-membership check
  (`isHostAllowed`) as defense in depth under the parser's strict grammar (no `//`
  opener, no `\`, no `#`, slot charset by `CONNECTION_SLOT_RULE`).
- **Same-row injection:** `resolveGrant` re-runs on the resolved host against the SAME
  rows read that resolution used (one read, no TOCTOU). A unique host match is
  necessarily the resolving slot's row; two matches refuse fail-closed
  (`NET_AMBIGUOUS_CONNECTION`) — the slot name never tiebreaks credential routing.

## New risks considered

- **R-A: resolved-host disclosure to the app.** The resolved host is the user's private
  fact (home-network layout for LAN rows). Mitigations: host-clean refusal messages on
  the symbolic path (the gate-5 SSRF refusal and the routing-ambiguity message branch);
  the resolved host + href join the scrub candidate set for transport error messages
  (ERROR-ONLY — see R-B). Residual: a provider that echoes its own address in a
  response BODY is visible to the app that asked. Accepted and documented (ADR-0026
  §3): that is the provider's data surface, and redacting private-IP shapes from JSON
  would corrupt legitimate payloads. The USER always sees the resolved host in the
  confirm dialog — the disclosure boundary is app-facing, not user-facing.
- **R-B: over-scrubbing.** Adding the resolved forms to the general scrub set would
  have redacted device payloads (e.g. Hue discovery data). The error-only candidate set
  is scoped to the one message class that can embed the URL (`NET_FETCH_FAILED`).
- **R-C: slot probing.** An app can probe slot names it never declared and learn
  whether a slot EXISTS on itself (`NET_INVALID_REQUEST` vs `NET_NOT_APPROVED`).
  Scope: the app's own rows only — an app's own declared slots are already its own
  knowledge (it declared them), so nothing crosses an app boundary. Cross-app rows are
  unreachable by construction (`listConnections(appId)`).
- **R-D: smuggling via pathAndQuery.** `https://<host>` + a hostile remainder could try
  to re-aim the parse (`//`, `@`, `\`, fragments). The parser refuses each shape; the
  post-parse canonical host check refuses anything that slips a future grammar change.
  Pinned by hostile-shape tests on both layers.
- **R-E: http-for-private-literals rung.** The resolved scheme is hardcoded `https`, so
  the ADR-0021 plain-http device rung is NOT reachable symbolically — refused at the
  scheme/pinned-lane conditions, never silently widened (ADR-0026 §5 carve-out).

## Out of scope (unchanged posture)

Settings pill truthfulness; live host→app status events (probe-on-load chosen at v1);
multi-host symbolic resolution (refused, not invented); the web Hue tile lock (owner's
queued UX call).
