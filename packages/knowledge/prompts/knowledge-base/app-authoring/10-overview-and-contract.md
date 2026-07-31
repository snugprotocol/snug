<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM queries app-authoring topics; reachable only when the host enables the app-builder capability
blast-radius: the mental model behind every generated app — errors here produce apps that violate the bridge contract or the SDK hook signatures
source: rewritten for Snug v0.1 from ancestor KBs (internal/05)
-->

# Snug App Authoring — Overview and Contract

## What a Snug App Is

A Snug app is ONE self-contained HTML file that runs in a sandboxed iframe inside the
conversation and thinks through the host's agent at runtime. The app is not a static page:
it sends structured actions to the agent (a chess move, a quiz answer, a data question) and
receives structured JSON replies that it turns back into UI state.

An app can:

- Send structured requests to the agent and await structured JSON replies
- Receive cumulative streaming text for display while the agent thinks
- Persist state across reloads through HOST-BROKERED storage (key-value and SQL)
- Use React 18 and other UMD libraries loaded from the allowed CDNs: {{cdnAllowlist}}

An app cannot: call `fetch`/`XMLHttpRequest` (network is blocked by CSP), use browser
storage (the sandbox has a null origin — storage exists only via the host bridge), open
windows, or reach any credential. Everything flows through `postMessage` frames.

## The Runtime Loop

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

Three hooks — included as copy-exactly code in the HTML template (see "The Mandatory HTML
Template") — are the ONLY way an app talks to the host:

- `useSnugApp({appId, displayName, description, iconEmoji, iconColor})` →
  `{isReady, theme, isWaiting, lastResponse, sendMessage}`. `sendMessage(action, payload,
  opts?)` returns a Promise resolving `{ok: true, data}` or `{ok: false, error}`.
- `usePersistedState(key, initial)` → `[state, setState]` — host-brokered key-value
  persistence with automatic hydrate-and-merge.
- `useAppDB()` → `{exec(sql, params?), exportDb(), importDb(bytesBase64)}` — a per-app SQL
  database brokered by the host.

## Hard Rules

- ONE HTML file, at most {{maxArtifactBytes}}. No separate assets, no build step.
- Copy the bridge runtime and hooks from the template EXACTLY — never rename, rewrite, or
  hand-roll postMessage plumbing.
- Every frame carries `v: 1`; the bridge adds it (and `instanceId`) for you.
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
