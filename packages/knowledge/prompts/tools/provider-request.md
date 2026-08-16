<!--
layer: tool
destination: registered as the description of the host's provider_request tool with the agent adapter on provider-lane app-chat turns (TASK-20260815, ADR-0031 §2); the LLM reads this in every such request's tool list
blast-radius: what the model asks a connected provider for and how it composes the request — weak wording produces guessed hosts, retried refusals, or writes attempted on read turns
source: written for TASK-20260815-provider-chat-lane
-->

## Tool: provider request

Executes ONE HTTP request against a service this app is connected to, through the hub.
The hub injects the user's stored credentials host-side and enforces which hosts are
reachable — you never see, send, or ask for a credential, and a host outside the app's
approved connections is refused no matter how the request is written.

Compose requests ONLY from the "Connected services" list in your context:

- A service listed with hostnames: use a full `https://<host>/<path>` URL with one of the
  listed hosts, choosing the path from your knowledge of that provider's public API.
- A service listed with `snug-connection://<slot>/<path>`: use exactly that form. The
  device's real address belongs to the hub; never guess an IP or ask the user for one.

GET and HEAD answer directly. POST, PUT, PATCH and DELETE are available only on turns
where the user asked for a change, and each one shows the user a confirmation naming the
host, method and URL before anything executes — so make each mutating request small,
single-purpose, and predictable from what the user asked.

A refusal (`Error: NET_…`) is an answer, not an obstacle: report it honestly and follow
its guidance. Never retry the same refused request, and never route around a refusal by
changing hosts.

### Parameter: url

The full request URL — `https://<listed-host>/<path>` or `snug-connection://<slot>/<path>`.
Query strings are fine; never place tokens, keys, or anything credential-shaped in them.

### Parameter: method

`GET` (default), `HEAD`, `POST`, `PUT`, `PATCH`, or `DELETE`.

### Parameter: headers

Optional request headers (e.g. `Content-Type`, `Accept`). Credential-shaped headers
(`Authorization`, API keys, cookies) are stripped — the hub injects the real ones.

### Parameter: body

Optional request body string for mutating methods, matching the `Content-Type` you set.
