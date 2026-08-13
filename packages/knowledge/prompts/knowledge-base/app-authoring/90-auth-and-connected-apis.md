<!--
layer: knowledge-base
destination: served section-by-section through {{appBuilderToolName}} retrieval; the summary layer's trigger clause sends every external-API build here BEFORE code is written (AL-05 AC5/AC10)
blast-radius: whether builder-authored apps reach external APIs through the host at all, whether the builder ever tries to place a credential in app code (C1), and whether a declared connection is COMPLETE — a requirement missing a field the provider needs produces an app that cannot authenticate and a user who cannot fix it. Headings are retrieval-load-bearing (AL-05 AC10, ADR-0004): a retrieval test pins that build-time auth queries return the emission teaching in searchKnowledge's top results — renaming or de-keywording headings can silently unserve this file.
source: written for Snug v0.2 (AL-05, TASK-20260806-auth-kb); rewritten for Dynamic Auth v2 (TASK-20260810-p2-pipeline, parent §5 R1/R3 — the full-requirement channel, the skip-rules, the completeness bar); platform-reach copy corrected for the shipped desktop shell + user-typed-LAN rule added (TASK-20260812-desktop-auth-awareness P2, ADR-0021, P0 security amendment 15). Anthropic prompt-engineering best practices re-read 2026-08-13.
-->

## Connected APIs: calling an external API with auth, login, and credentials

Snug apps can use real external APIs — weather, music, repos, market data — even ones
behind authentication: an API key, a bearer token, or a "sign in with Google"-style
OAuth login. A sandboxed app has NO network of its own: every external HTTP call
travels through the host, and the host holds the user's credentials and access tokens
and injects them into requests outside the app. Building a connected app has exactly two
parts, both yours:

1. **In the app code** — call external APIs only through the `useConnectedFetch` hook
   (copy it exactly from §5 of the template).
2. **In your chat reply** — declare what the connection NEEDS by emitting ONE
   `{{connectionRequirementDirectiveKind}}` render directive (contract below), which makes
   the host show the user a connect card.

Credentials live with the host, always. The user's API keys and tokens are stored by the
host and injected only after the user approves the connection. App code, app storage, and
your directive carry zero secrets: never write a key into the HTML, never add a key-entry
input to an app, never ask for a secret in chat. There is no key for you to write — the
user's credential is the host's to hold and inject, and it is never handed to you or to
the app. So a key in app code is two failures at once: the app is broken for the user
whose real credential it ignores, and whatever value you typed is now sitting in source
the user can publish. Write the call, declare what the provider requires, and let the host
collect and supply the credential.

### Design the app against useConnectedFetch (it must work before it is connected)

`useConnectedFetch` always resolves — `{ ok: true, status, headers, body }` on success,
`{ ok: false, error }` otherwise — and before the user approves the connection every call
resolves `{ ok: false }`. Design for that from the first render: show a friendly
"connect <provider> to see live data" state, keep the rest of the app usable, and retry
naturally on the next user action once connected. A blank screen or a spinner that never
settles is a broken app. When you need external data, pick the provider while you write
the code — the hostnames you call in the app are the same hostnames you declare in the
`{{connectionRequirementDirectiveKind}}` directive below.

### Research the provider's authentication before you declare it

Declare what the provider ACTUALLY requires, in this order of authority:

1. **The host's pinned registry.** For a well-known provider, name it and the host
   substitutes its own verified hosts, endpoints and sign-up copy over anything you
   declare. Your job there is the name, correctly spelled.
2. **What you know about the provider.** Most API-key providers are documented well
   enough that you know the header names and the values they carry. Use that knowledge.
3. **Documentation the user pastes.** If the user gives you the provider's auth docs,
   read them and declare from the text in front of you.

If none of those answers the question, say so plainly in your reply and declare only what
you are sure of. An honestly incomplete declaration the user can correct is better than a
confident wrong one: a wrong hostname freezes a ceiling that refuses every real request,
and the user sees it as an authentication bug with no way to diagnose it. There is no
live-fetch rung — the host never fetches a documentation URL for you (fetching arbitrary
URLs would be an unfrozen network surface beside the frozen host allowlist).

What the host can reach differs by platform, and only by platform — the rules above hold
everywhere. In the Snug desktop app the host's own fetch is native, so providers that
refuse cross-origin browser calls still work there once their hosts are approved; and a
device on the user's own network — a private RFC-1918 IPv4 address the user approves —
is reachable from the desktop app only. The browser version of Snug refuses private
ranges. A LAN address is always typed by the user in the connect flow: never propose,
guess, or invent a private address in a requirement.

### Declare the connection: emit the {{connectionRequirementDirectiveKind}} directive as you build

This directive is how the user gets to log in or hand over a key: it is the only way an
app you build ever becomes connected. Emit it as part of the build — the declaration is
stored with the app version, so the connect card is there BEFORE the app is first run, not
discovered later when a call fails. Nothing infers this for you at run time.

Emit it when, and only when, the app you just wrote or modified NEWLY needs a provider
connection:

- The app calls `useConnectedFetch` → close that same reply with exactly one directive.
- The app makes no external calls → no directive.
- The app would need TWO OR MORE providers → still one directive, for one provider
  only, and say so in the reply (see below). Never bundle two providers into one
  declaration.

After the app write, end your reply with one fenced json code block holding only the
directive object:

- `v` — the protocol version, always {{protocolVersion}}.
- `kind` — always `{{connectionRequirementDirectiveKind}}`.
- `requirement` — what the app needs:
  - `slot` (always): a short lowercase id for this connection within the app, e.g.
    `coinbase`. Letters, digits and dashes.
  - `provider` (always): `{ "name": "..." }`, the provider's common name, plus optional
    `homepageUrl` and `docsUrl`. Spell the name correctly — the host matches it against
    its pinned registry.
  - `kind` (always): one of {{connectionKinds}} — how the provider authenticates.
  - `declaredApiHosts` (always): exactly the bare hostnames your app's code passes to
    `useConnectedFetch`, no more. You know them — you wrote the calls. These become the
    ceiling the user approves; a host you leave out is blocked, and a host you add
    needlessly is one the user is asked to trust.
  - the credential fields, the registration walkthrough, and the header placement —
    described in the next three sections, because getting them complete is the whole job.

The host validates strictly: a directive carrying keys it does not recognize is dropped
whole. The directive is a REQUEST, not an authority — the host independently re-resolves
well-known providers, and the user reviews every field and every host before anything is
saved or any credential is collected. Your app keeps working in its not-yet-connected
state until then.

The directive is your channel, and the only one you have. The host has one other: an app
the user installs from the built-in shelf can arrive already declaring what it needs, so
the user's install brings that declaration to the same connect card. You never produce
that kind of app and there is nothing for you to emit for it — it is described here only
so you do not conclude that an app without a build conversation could never be connected,
and so you never emit a directive for an app you did not just write.

### Declare EVERY credential the provider requires (the completeness bar)

Declare every field that provider requires to authenticate — not the first one, not the
most famous one. **A key without its secret is a defect.** A partial declaration produces
an app that cannot authenticate and a user with no way to supply the missing value: the
connect card asks for what you declared, the host injects what it collected, and the
provider rejects the request.

So count the values the provider's own sign-in flow hands out. Meridian Exchange issues
three — a key, a secret, and a passphrase — and all three must be declared. A provider
issuing one key gets one field.

Each entry in `requirement.fields` describes ONE value the user will paste:

- `key` — lowercase identifier, e.g. `api_key`. This is the name you reference in the
  header placement below.
- `label` — what the user sees above the input, e.g. "API Secret".
- `type` — `text` for a visible value, `secret` for one that must be masked. Anything
  the provider calls a secret, a passphrase or a private key is `secret`.
- `description` (optional) — one line of help, e.g. where the value appears in the
  provider's console.
- `required` — true unless the provider genuinely treats it as optional.

You are describing the SHAPE of the credential, never its value. You have no credential
to supply and must never invent an example one: these are empty inputs the user fills.

### Tell the user where to get the credential (registration walkthrough)

The user has to go and create the credential before they can paste it, so
`requirement.registration` carries the walkthrough:

- `consoleUrl` — the page where the credential is created.
- `instructions` — short ordered steps, in the order they must be done.

Order carries meaning here: if the provider shows a value exactly once, the step that says
so must come BEFORE the step that closes the dialog. Write the steps you would give a
person sitting at the provider's site for the first time.

### Tell the host where the credential goes (header placement)

For key-and-secret providers, `requirement.request.headerTemplate` maps header names to
values the HOST renders — outside the app, after approval, with the real credential. You
write the SHAPE with `{{{fieldKey}}}` references; the host substitutes the values.

You may reference:

- any `key` you declared in `fields`;
- `request.timestamp`, `request.method`, `request.url`, `request.pathAndQuery`,
  `request.body` — facts about the outgoing request;
- four helpers: `timestamp`, `base64`, `hmac_sha256`, `hmac_sha256_b64`.

A reference to anything else is rejected, and the directive with it — the host will not
guess what you meant, because a typo'd field name in a signature silently signs the wrong
bytes and produces a plausible-looking signature the provider rejects.

Never place a literal credential in a template. Every value is a reference.

### Editing a connected app: when to re-emit, and when to skip

Re-emit the directive ONLY when your edit changes what the connection NEEDS. This matters
because re-emitting is not free: if the user has already approved the connection, a
changed requirement stages a re-approval request, and asking someone to re-approve a
connection they did not change is noise that trains them to click through the review that
protects them.

Re-emit when:

- the app newly calls `useConnectedFetch` and had no connection before;
- a later edit adds a NEW provider (one directive, for the new provider);
- the app now calls a hostname that is not in the declared `declaredApiHosts`;
- you learn the declaration was incomplete or wrong — a missing field, a wrong header.

Skip — emit NOTHING — when:

- the edit was UI-only: layout, styling, copy, a new view over the same data;
- the edit changed app logic but did not change the auth surface;
- a valid requirement already exists and your edit asked nothing new of it.

Re-emitting an unchanged requirement is a no-op, not a safety net: the host compares it to
what is stored and writes nothing. But you cannot rely on that to excuse a careless
re-emit, because a requirement you changed WHILE re-emitting — a reordered walkthrough, a
dropped field — reads as a real edit and asks the user to approve again. When in doubt
about whether your edit touched the auth surface, it did not; skip.

### Providers the host already knows: declare the SHAPE, never the brand's copy

Some providers are pinned in the host's own registry — Spotify, GitHub, Google, Gmail,
Coinbase, OpenWeather, CoinGecko and friends. For those, the host already holds a
human-reviewed field list, registration walkthrough and host list, and it substitutes them
over anything you write.

So when the provider is one the host knows, declare only what you legitimately know — the
`slot`, the `kind`, and `declaredApiHosts` — and **omit `fields`, `request.headerTemplate`
and `testRequest`**. Omit them and you receive the pinned, reviewed versions. Author them
next to a known brand and the whole requirement is **refused**, because credential-prompt
copy sitting beside a trusted brand is exactly how a user is talked into pasting the wrong
secret.

This is matched on the brand, not on an exact spelling: "Spotify", "Spotify Inc",
"Spotify Connect" and "SpotifyPremium" are all treated as naming Spotify. **Do not reach
for a brand-adjacent name to get around the rule** — a name that merely borrows a known
brand's word is refused the same way, and that is deliberate.

If you are describing a genuinely different provider, give it its own name that does not
contain a known brand's, and declare its fields normally. The example below does exactly
that.

### Example: a three-value signed API (Meridian Exchange)

The user asks for a portfolio tracker. The app calls
`https://api.meridian-exchange.example/...` through `useConnectedFetch`, renders a
"connect Meridian Exchange to see your balances" state while unconnected, and the reply
ends with the declaration below. Meridian Exchange is NOT a provider the host pins, so the
app declares the credential shape itself. It issues three values and signs every request,
so all three are declared and the signature is expressed as a template:

```json
{"v": {{protocolVersion}}, "kind": "{{connectionRequirementDirectiveKind}}", "requirement": {"slot": "meridian", "provider": {"name": "Meridian Exchange", "docsUrl": "https://docs.meridian-exchange.example"}, "kind": "api_key", "fields": [{"key": "api_key", "label": "API Key", "type": "text", "required": true}, {"key": "api_secret", "label": "API Secret", "type": "secret", "description": "Shown once at creation. Copy it before closing the dialog.", "required": true}, {"key": "passphrase", "label": "Passphrase", "type": "secret", "description": "The passphrase you chose while creating the key.", "required": true}], "registration": {"consoleUrl": "https://meridian-exchange.example/profile/api", "instructions": ["Sign in at meridian-exchange.example and open Profile then API.", "Choose New API Key and give it View permission only.", "Choose a passphrase and write it down — it is not shown again.", "Copy the API key and the secret before closing the dialog."]}, "request": {"headerTemplate": {"CB-ACCESS-KEY": "{{{api_key}}}", "CB-ACCESS-PASSPHRASE": "{{{passphrase}}}", "CB-ACCESS-TIMESTAMP": "{{request.timestamp}}", "CB-ACCESS-SIGN": "{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}"}}, "declaredApiHosts": ["api.meridian-exchange.example"]}}
```

Three values, three inputs on the connect card, and a signature the host computes with a
secret you never see. Declaring only `api_key` here would produce an app that cannot sign
a single request.

Had this been a provider the host pins, the same app would declare only the slot, the kind
and `declaredApiHosts`, and the reviewed field list would be filled in for it.

### Example: a single-key API the host already knows (OpenWeather)

The user asks for a weather dashboard. OpenWeather **is** a provider the host pins, so the
declaration carries only the slot, the kind and the host — no `fields`, no `registration`,
no header template. The reviewed field list and walkthrough are filled in by the host:

```json
{"v": {{protocolVersion}}, "kind": "{{connectionRequirementDirectiveKind}}", "requirement": {"slot": "openweather", "provider": {"name": "OpenWeather"}, "kind": "api_key", "declaredApiHosts": ["api.openweathermap.org"]}}
```

This is the shape to copy for every pinned provider. Adding a `fields` array here — even a
correct one — would get the whole requirement refused.

### Example: no directive — an app with no external API

A to-do list, a board game against the agent, a habit tracker: these use persistence and
the agent bridge but make no external calls, so there is no `useConnectedFetch` and no
directive. The runtime agent bridge (`sendMessage`) is host-internal — never emit a
directive for it.

### An app that would need two or more providers (one connection per app)

An app holds ONE connected provider in this version, so a second directive in the same
reply never reaches the user. Pick the provider the app's primary live feature needs and
declare that one; `declaredApiHosts` then carries only the declared provider's
hostnames, never the other's — an undeclared host is blocked with no way to connect it.
Then tell the user plainly: the app supports one connected provider at this version, so
the second feature ships with manual entry or sample data. Build that second feature
that way in the same write, so the app is whole. Do not quietly drop it.

### Keyless public APIs (a provider with no credential)

A provider that needs no credential is declared with `kind` `none`: it carries
`declaredApiHosts` and no credential fields, because keyless means "no credentials", never
"no host gate". The user still approves the hosts before the app can reach them. When a
request could be served either by a keyless provider or by one issuing free-tier keys,
prefer whichever the user asked for and say which you chose.

### What the user sees (net requests in the frames timeline)

The connect card renders above your reply; approving it opens the host's connection
wizard, which shows the user every field, every host and every registration step you
declared, verbatim, before a single credential is collected. After approval the app's
calls go through the host, and net traffic surfaces in the host's frame timeline as
structure only — request and response bodies and credentials never appear there. Mutating
calls (POST/PUT/PATCH/DELETE) ask the user to confirm before the write goes out (the user
may remember that grant for the session). Design copy accordingly: the host, not the app,
is where the user controls and audits network access.
