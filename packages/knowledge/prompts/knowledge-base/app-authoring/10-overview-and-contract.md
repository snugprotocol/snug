<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM queries app-authoring topics; reachable only when the host enables the app-builder capability
blast-radius: the mental model behind every generated app — errors here produce apps that violate the bridge contract or the SDK hook signatures
source: rewritten for Snug v0.1 from ancestor KBs (internal/05)
-->

# Snug App Authoring — Overview and Contract

## What a Snug App Is

A Snug app is ONE self-contained HTML file that runs in a sandboxed iframe inside the
conversation, announces itself to the host, and persists its state through the host bridge.
That contract — one file, the sandbox, host-brokered storage — is what makes something a
Snug app.

Reaching the agent is a CAPABILITY an app MAY use, not part of the definition. An app that
never calls the agent is a first-class Snug app: an arcade game, a timer, a drawing pad, a
calculator are complete without a single model round trip. Do not add one to qualify.

An app can:

- Persist state across reloads through HOST-BROKERED storage (key-value and SQL)
- Use React 18 and other UMD libraries loaded from the allowed CDNs: {{cdnAllowlist}}
- OPTIONALLY send structured requests to the agent and await structured JSON replies
- OPTIONALLY receive cumulative streaming text for display while the agent thinks

Apps that DO think through the agent send structured actions (a chess move, a quiz answer,
a data question) and turn the structured JSON replies back into UI state. See "Choosing an
App Type" for deciding, per app, whether a turn needs the model at all.

An app cannot: call `fetch`/`XMLHttpRequest` (network is blocked by CSP), use browser
storage (the sandbox has a null origin — storage exists only via the host bridge), open
windows, or reach any credential. Everything flows through `postMessage` frames. External
APIs are still reachable — the HOST makes the call on the app's behalf through
`useConnectedFetch`; see "Connected APIs".

## The Runtime Loop

Steps 1-2 are the WHOLE loop for an app that does not use the agent — after host-ready it
simply runs. Steps 3-5 describe one agent round trip, and happen only when the app calls
`sendMessage`.

1. On mount the app announces itself ({{frameType:announce}}) with its display metadata.
2. The host replies {{frameType:hostReady}}, delivering `instanceId`, `theme`, and
   `capabilities`. The app is now connected.
3. A user action becomes `sendMessage(action, payload, opts)` — an {{frameType:appMessage}}
   frame carrying a fresh `requestId`, the FULL app state, and a `responseSchema`.
4. The host wraps the request in a {{envelopeTag}} envelope, sends it to its agent, and the
   agent replies with ONLY a JSON object.
5. The host delivers {{frameType:appResponse}} frames back: zero or more `streaming: true`
   frames (cumulative display text), then exactly ONE terminal frame — `ok: true` with the
   parsed `data`, or `ok: false` with a structured `error`. The app renders the result.

## The SDK Hooks (the whole app-side API)

These hooks — included as copy-exactly code in the HTML template (see "The Mandatory HTML
Template") — are the ONLY way an app talks to the host. The first three are always
present; the fourth appears only in apps that call an external API:

- `useSnugApp({appId, displayName, description, iconEmoji, iconColor})` →
  `{isReady, theme, isWaiting, lastResponse, sendMessage}`. `sendMessage(action, payload,
  opts?)` returns a Promise resolving `{ok: true, data}` or `{ok: false, error}`.
- `usePersistedState(key, initial)` → `[state, setState]` — host-brokered key-value
  persistence with automatic hydrate-and-merge.
- `useAppDB()` → `{exec(sql, params?), exportDb(), importDb(bytesBase64)}` — a per-app SQL
  database brokered by the host.
- `useConnectedFetch()` → `{fetch(url, opts?)}` — host-mediated calls to the app's
  approved external hosts; always resolves `{ok: true, status, headers, body}` or
  `{ok: false, error}`. See "Connected APIs".

## Hard Rules

- ONE HTML file, at most {{maxArtifactBytes}}. No separate assets, no build step.
- Copy the bridge runtime and hooks from the template EXACTLY — never rename, rewrite, or
  hand-roll postMessage plumbing.
- Every frame carries `v: {{protocolVersion}}`; the bridge adds it (and `instanceId`) for you.
- Send FULL state with every request — the agent has no memory of prior turns.
- Always include a `responseSchema` and always expect a `message` field in replies.
- Errors are data: an `{ok: false, error}` result must be rendered by the app, never thrown.
- Multiple in-flight requests are legal; each has its own `requestId`.

## Section Map

- "The Mandatory HTML Template" — the skeleton and copy-exactly hook code
- "Bridge Protocol" — frames, envelope, JSON-only replies, streaming, errors
- "Persistence and the App Database" — key-value state, SQL schema design
- "App Catalog" — app types with per-type guidance and a worked chess example
- "Design Quality" — theming, layout, animation, touch targets, empty states
- "Defensive Coding" — what NOT to do; crash-proofing rules
- "CDN Compatibility" — UMD vs ESM and the pinned known-good library table
- "Connected APIs" — `useConnectedFetch`, declaring auth, credentials the host holds
