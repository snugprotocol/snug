# Snug Protocol — SPEC v0.1 (DRAFT, staged for snugprotocol/spec)

> Staged here per SPEC_SYNC.md. Never pushed to the spec repo without an explicit ask.
> Normative schemas: [`schemas/*.json`](schemas/) (generated from `src/`, byte-stable).

Snug connects agents to apps: LLM-authored single-file HTML micro-apps run in a sandboxed
iframe and think through the **host's** agent at runtime, over two coupled contracts:

1. **Frames** — postMessage messages between app iframe and host runner.
2. **Chat envelope** — the tagged message a host sends to its own agent endpoint for an
   app-originated turn, and the JSON-only reply contract for the agent.

## Normative rules

- **R1 Versioning.** Every frame carries `v: 1`; the chat envelope carries `snug: 1`.
  Unsupported versions are rejected with `UNSUPPORTED_VERSION`. Parse failures surface a
  `requestId` recovered from the raw frame when it carried a plausible string id; hosts
  answer `UNSUPPORTED_VERSION`/`MALFORMED` on the wire only in that case (never otherwise).
  `snug:host-ready.protocolVersions` advertises support.
- **R2 Additivity.** A frame with a valid `v` but unrecognized `snug:*` type MUST be silently
  ignored. Unknown fields on known frames MUST be ignored. The `snug:` type prefix and the
  `event` namespaces are reserved for the spec.
- **R3 Terminal frame.** Every accepted `requestId` receives exactly one terminal
  `snug:app-response` (`ok:true, streaming:false` or `ok:false`). `streaming:true` frames are
  cumulative prose, display-provisional; the terminal frame is authoritative. Hosts MAY
  suppress streaming for schema-constrained requests. (`mode: 'delta'` + `seq` reserved.)
- **R4 Identity.** Hosts route by `event.source` (sandboxed iframes have a null origin;
  `targetOrigin` is necessarily `'*'`). The host mints `instanceId` (delivered in
  `snug:host-ready`); apps echo it in every request. A new `snug:app-announce` from the same
  iframe invalidates in-flight work (`SUPERSEDED`). `appId` is display metadata, **not** a
  security principal. `requestId` MUST be unique per instance (SDK uses UUIDs).
- **R5 Error codes.** `error.code` is an open string; known codes:
  `PARSE_FAILED`, `THREAD_CONFLICT`, `NETWORK_ERROR`, `RESET_FAILED`, `CANCELLED`,
  `SUPERSEDED`, `UNSUPPORTED_VERSION`, `CONSENT_REQUIRED` (reserved), `AUTH_REQUIRED`
  (reserved for the v1.1 credential broker), `HOST_ERROR`. Receivers treat unknown codes per
  `retryable` and render as `HOST_ERROR`.
- **R6 Limits.** Frames ≤ 256 KiB, except `db-request`/`db-response` ≤ 8 MiB (their own
  size class, so a base64-encoded 5 MiB artifact round-trips through the db bridge);
  artifacts ≤ 5 MiB; `rawExcerpt` ≤ 200 chars; announce
  strings capped (displayName 80, description 400). Parse-failure budget: 3 consecutive,
  then the host requires an explicit user reset. Thread-conflict backoff: 100/250/500 ms.
- **Security (C1/C2).** Credentials never enter the iframe, the LLM payload, or a publisher.
  Hosts MUST strip `authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `proxy-authorization` from any app-originated request at the envelope boundary. Iframes run
  `sandbox="allow-scripts"` only — storage is therefore **host-brokered** via db frames.

## Frames

| Type | Direction | Purpose |
|---|---|---|
| `snug:app-announce` | app → host | Self-describing metadata on mount (appId, displayName, description, iconEmoji, iconColor). Hosts ack with `snug:host-ready`. |
| `snug:host-ready` | host → app | On iframe load AND as announce-ack (idempotent): `instanceId`, `protocolVersions`, `capabilities {streaming, db, auth}`, `theme`, `locale?`. |
| `snug:app-message` | app → host | An agent request: `requestId`, `instanceId`, `appId`, `action`, structured `payload?`, `state?`, `responseSchema?`. |
| `snug:app-cancel` | app → host | Abort an in-flight `requestId`. |
| `snug:app-response` | host → app | Streaming / final / error, per R3. |
| `snug:db-request` / `snug:db-response` | app ↔ host | Host-brokered per-app storage: `op ∈ exec, export, import, kvGet, kvSet`. |
| `snug:host-event` / `snug:app-event` | either | Open additive channel (`theme-change`, `visibility`, `resize {height}`, …); unknown events ignored. |

## Chat envelope

Wire form: `[SNUG_APP_REQUEST]\n{json}` where json = `{snug: 1, appId, instanceId, requestId,
action, payload?, state?, responseSchema?}`. Detection = tag prefix **and** `snug: 1` marker.
Servers SHOULD skip thread history for app requests (the envelope is self-contained via
`state`) and MUST apply the C1 header strip.

**Agent reply contract:** the agent responds with ONLY a JSON object (a human-readable
`message` field is recommended). Hosts parse with fence tolerance (raw parse → fenced block →
balanced-object extraction), reject null/array/scalar, and convert failures to `PARSE_FAILED`
frames carrying `rawExcerpt` and `attemptsRemaining`.

## Lineage

Unifies two production ancestors; deliberate deltas: versioning and correlation added;
structured response frames replace both ancestors' shapes (fixing a shipped host/SDK
disagreement); ready signal ack'd instead of timer-fired; storage host-brokered (one ancestor
taught localStorage, which only worked via a sandbox escape the spec forbids); error codes,
parse budget, and backoff adopted from the hardened ancestor.
