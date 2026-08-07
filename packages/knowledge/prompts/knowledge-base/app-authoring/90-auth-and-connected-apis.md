<!--
layer: knowledge-base
destination: served section-by-section through {{appBuilderToolName}} retrieval; the summary layer's trigger clause sends every external-API build here BEFORE code is written (AL-05 AC5/AC10)
blast-radius: whether builder-authored apps reach external APIs through the host at all, and whether the builder ever tries to place a credential in app code (C1). Headings are retrieval-load-bearing (AL-05 AC10): a retrieval test pins that build-time auth queries return the emission teaching in searchKnowledge's top results — renaming or de-keywording headings can silently unserve this file.
source: written for Snug v0.2 (AL-05, TASK-20260806-auth-kb; Anthropic prompt-engineering best practices read 2026-08-06)
-->

## Connected APIs: calling an external API with auth and credentials

Snug apps can use real external APIs — weather, music, repos, market data — even ones
that need an API key or an OAuth login. A sandboxed app has NO network of its own: every
external call travels through the host, and the host holds the user's credentials and
injects them into requests outside the app. Building a connected app has exactly two
parts, both yours:

1. **In the app code** — call external APIs only through the `useConnectedFetch` hook
   (copy it exactly from §5 of the template).
2. **In your chat reply** — declare the connection the app needs by emitting ONE
   `{{authWizardDirectiveKind}}` render directive (contract below), which makes the host
   show the user a connect card.

Credentials live with the host, always. The user's API keys and tokens are stored by the
host and injected only after the user approves the connection. App code, app storage, and
your directive carry zero secrets: never write a key into the HTML, never add a key-entry
input to an app, never ask for a secret in chat. The host strips credential-shaped
headers from app requests, so a hardcoded key could not work even if you wrote one.

### Design the app against useConnectedFetch (it must work before it is connected)

`useConnectedFetch` always resolves — `{ ok: true, status, headers, body }` on success,
`{ ok: false, error }` otherwise — and before the user approves the connection every call
resolves `{ ok: false }`. Design for that from the first render: show a friendly
"connect <provider> to see live data" state, keep the rest of the app usable, and retry
naturally on the next user action once connected. A blank screen or a spinner that never
settles is a broken app. When you need external data, pick the provider while you write
the code — the hostnames you call in the app are the same hostnames you declare in the
`{{authWizardDirectiveKind}}` directive below.

### Declare the connection: emit the {{authWizardDirectiveKind}} render directive (auth declaration)

Emit the directive when, and only when, the app you just wrote or modified NEWLY needs a
provider connection:

- The app calls `useConnectedFetch` → close that same reply with exactly one directive.
- The app makes no external calls → no directive.
- You edited an already-declared app without adding a provider → no directive again.
- A later edit adds a NEW provider → one directive for the new provider.

After the app write, end your reply with one fenced json code block holding only the
directive object:

- `v` — the protocol version, always {{protocolVersion}}.
- `kind` — always `{{authWizardDirectiveKind}}`.
- `proposal` — at most three members:
  - `providerName` (always): the provider's common name, e.g. "OpenWeather" or
    "Spotify". For well-known providers the host resolves everything else from its
    pinned registry — give the name only, never authorization or endpoint URLs (the
    registry's URLs are verified; yours cannot be).
  - `kindHint` (when the docs make it obvious): one of {{authKinds}}.
  - `declaredApiHosts` (when the app calls external hosts — usually yes): exactly the
    bare hostnames your app's code passes to `useConnectedFetch`, no more. You know
    them — you wrote the calls.

Emit only `v`, `kind`, `proposal`: the host validates strictly — a directive carrying
keys it does not recognize is dropped whole. The directive is a doorbell, not an authority — it opens
the connect card, the host independently resolves the provider, and the user reviews and
approves every host before anything is saved. Your app keeps working in its
not-yet-connected state until then.

### Example: a weather app with an API key provider

The user asks for a weather dashboard using OpenWeather. The app's code calls
`https://api.openweathermap.org/...` through `useConnectedFetch`, renders a
"connect OpenWeather to see live weather" state while unconnected, and the reply ends
with:

```json
{"v": {{protocolVersion}}, "kind": "{{authWizardDirectiveKind}}", "proposal": {"providerName": "OpenWeather", "kindHint": "api_key", "declaredApiHosts": ["api.openweathermap.org"]}}
```

### Example: no directive — an app with no external API

A to-do list, a board game against the agent, a habit tracker: these use persistence and
the agent bridge but make no external calls, so there is no `useConnectedFetch` and no
directive. The runtime agent bridge (`sendMessage`) is host-internal — never emit a
directive for it.

### Keyless public APIs (a provider with no credential)

Every external host still requires a user-approved connection, and connections in this
version carry a credential (one of {{authKinds}}). When the user's request can be served
by a provider that issues API keys — including free-tier keys — prefer that provider and
declare it normally. If the user insists on a provider with truly no credential to hold,
say plainly that connected data for it is not supported yet, and ship the app with a
manual-entry or sample-data mode so it is still useful.

### What the user sees (net requests in the frames timeline)

The connect card renders above your reply; approving it opens the host's connection
wizard. After approval the app's calls go through the host, and net traffic surfaces in
the host's frame timeline as structure only — request and response bodies and
credentials never appear there. Mutating calls (POST/PUT/PATCH/DELETE) ask the user to
confirm before the write goes out (the user may remember that grant for the session).
Design copy accordingly: the host, not the app, is where the user controls and audits
network access.
