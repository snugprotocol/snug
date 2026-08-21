<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM queries frames, envelope, streaming, or error handling; reachable only when the app-builder capability is enabled
blast-radius: how generated apps understand the wire — errors here produce apps that mis-parse responses, resolve on streaming frames, or crash on ok:false
source: rewritten for Snug v0.1 from ancestor KBs; normative shapes from packages/protocol SPEC v0.1
-->

# Bridge Protocol

## Frames at a Glance

Every frame is a `postMessage` object carrying `v: {{protocolVersion}}` and (once known) `instanceId`. The
template's bridge runtime handles all of this — this section is the mental model, not code
you write yourself.

| Frame type | Direction | Purpose |
|---|---|---|
| `{{frameType:announce}}` | app → host | Self-describing metadata on mount (appId, displayName, description, iconEmoji, iconColor) |
| `{{frameType:hostReady}}` | host → app | Ack: delivers `instanceId`, `theme`, `capabilities`, supported protocol versions |
| `{{frameType:appMessage}}` | app → host | An agent request: `requestId`, `action`, `payload?`, `state?`, `responseSchema?` |
| `{{frameType:appCancel}}` | app → host | Abort an in-flight `requestId` — reserved: the host/runner honors it; a convenience canceller lands in the SDK (until then an app may hand-roll posting this frame) |
| `{{frameType:appResponse}}` | host → app | Streaming, final, or error reply (see Terminal Frame Rule) |
| `{{frameType:dbRequest}}` / `{{frameType:dbResponse}}` | app ↔ host | Host-brokered storage: `op` ∈ `exec`, `export`, `import`, `kvGet`, `kvSet` |
| `{{frameType:hostEvent}}` / `{{frameType:appEvent}}` | either | Open additive channel (`theme-change`, `visibility`, `resize`, …) — unknown events are ignored |

## Identity and Correlation

- The HOST mints `instanceId` and delivers it in `{{frameType:hostReady}}`; the bridge
  echoes it in every subsequent frame. Announce is the only frame sent before it is known.
- `requestId` must be unique per instance — the bridge uses `crypto.randomUUID()`.
- Multiple requests may be in flight at once; responses are matched by `requestId` in a map.
  A single "current request" slot is a bug: a second request would clobber the first.
- Re-announcing (e.g. after a reload) invalidates in-flight work — outstanding requests
  terminate with the `SUPERSEDED` error code.

## Terminal Frame Rule

Every accepted `requestId` receives EXACTLY ONE terminal `{{frameType:appResponse}}`:

- Success: `{ ok: true, streaming: false, data }` — `data` is the agent's reply, already
  parsed into an object. This resolves the `sendMessage` Promise.
- Failure: `{ ok: false, error: { code, message, retryable, ... } }` — also terminal.

Before the terminal frame, the host MAY deliver `{ ok: true, streaming: true, text }`
frames. `text` is CUMULATIVE, human-readable, display-provisional prose — surface it via
`opts.onStream` for a live "thinking" panel, but NEVER parse it and NEVER treat it as the
result. Hosts may suppress streaming entirely for schema-constrained requests, so an app
must work perfectly when only the terminal frame arrives.

## The Chat Envelope (what the host does with your request)

When an app calls `sendMessage`, the host wraps the request in a tagged envelope and sends
it to its own agent endpoint as a message beginning with `{{envelopeTag}}` followed by a
JSON body carrying the appId, instanceId, requestId, action, payload, state, and
responseSchema. Because `state` makes the request self-contained, the host typically skips
thread history — which is why the app must ALWAYS send full state.

## JSON-Only Reply Rule

The agent answering an app request MUST reply with ONLY a JSON object — no prose, no
markdown, no code fences, nothing before or after. The host parses the entire reply. This
is why every request should carry `responseSchema`: it tells the agent exactly what shape
to return. Always include a `message` field in your schema so the agent has a place for
human-readable commentary, and render that commentary in your UI — it is where the
personality lives.

## Errors Are Data

An `{ok: false, error}` result is NOT an exception. The app owns its error UX: show a
readable notice, keep state intact, and offer a retry when `error.retryable` is true.

Known `error.code` values:

| Code | Meaning | App behavior |
|---|---|---|
| `PARSE_FAILED` | The agent's reply was not valid JSON | Show `error.rawExcerpt` (up to {{rawExcerptChars}} chars of the raw reply) and `error.attemptsRemaining`; offer retry while attempts remain |
| `CANCELLED` | The request was cancelled ({{frameType:appCancel}}) | Discard silently or note it |
| `SUPERSEDED` | A newer announce invalidated this request | Discard; the new instance owns the session |
| `NETWORK_ERROR` | Host could not reach its agent | Offer retry |
| `THREAD_CONFLICT` | Concurrent host-side turn conflict | Retry is usually safe (`retryable: true`) |
| `HOST_ERROR` | Anything else, including unknown codes | Show the message; honor `retryable` |

Codes are open strings — treat any unrecognized code exactly like `HOST_ERROR` and honor
the `retryable` flag.

## PARSE_FAILED Budget

The host allows {{maxParseFailures}} consecutive parse failures per instance. Each `PARSE_FAILED` error
carries `attemptsRemaining`; when the budget is exhausted the HOST takes over and shows the
user a reset affordance — the app does not need to build one. The app's job is only to
display what happened (use `rawExcerpt`) and not to auto-retry in a loop.

## Events Channel

`{{frameType:hostEvent}}` frames carry `{event, data}` — e.g. `theme-change` (the bridge
updates `theme` automatically), `visibility`, `resize`. Apps may post `{{frameType:appEvent}}`
frames the same way. Both sides MUST ignore events they do not recognize; the channel is
additive by design. Never invent frame types — the `snug:` type prefix is reserved for the
protocol.

## Limits

- Frames: {{maxFrameKiB}} max — keep `state` lean (see "Persistence and the App Database" for what
  belongs in state vs the database).
- Announce strings: displayName 80 chars, description 400 chars.
- `action`: 128 chars max.
