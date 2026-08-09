# connection demo

The walking skeleton for **connected apps**: one button, one real API call, and an
honest picture of who approves it. This is the only example that actually calls an
external API through the governed seam — every other example only *defines* the hook.

## What it demos

- **The governed seam, really called**: the button calls `net.fetch(ENDPOINT)` — a
  *method* on the handle `useConnectedFetch()` returns. The app has no network of its
  own (`connect-src` is blocked, C2), so this is the only way out: the host resolves the
  approved-host list, injects the user's credential, and returns a scrubbed body. The
  key never enters this page and never reaches a model (C1).
- **The install-act declaration**: this folder ships a `connection.json`. When the user
  installs the app, that declaration is carried into the *same* strong field-by-field
  approval review the builder-LLM directive gets — it only **prefills** the review, it
  never shortens it. This is the third rung of the trust ladder, and the reason a
  chat-less app can be connected at all.
- **The un-connected state, shown as a next step**: before approval every call resolves
  `{ ok: false, error: { code: 'NET_NOT_APPROVED' } }`, and the app renders that plainly
  with what to do about it. That state is where every new user starts, so a blank screen
  or a dead spinner there would be the whole demo failing.
- **LLM-free by declaration (ADR-0011)**: `RESPONSE_SCHEMA = null`, no `sendMessage` in
  authored code. Deliberate — a model in the loop would blur the one thing being shown,
  because you could not tell whether the body on screen came off the wire or out of a
  sentence generator.

## Files

- `app.html` — the single-file app (hooks block byte-synced to `packages/sdk/embedded/snug-hooks.js`).
- `connection.json` — the declared connection: provider `Example API`, host
  `api.example.com`. Validated against the real `llmProposalSchema` by the validate suite.

## Note on the endpoint

`api.example.com` is a reserved example host and answers nothing. That is fine, and
somewhat the point: this app exists to demonstrate the *approval journey* — declaration →
review → approve → brokered call — not to show a payload. Point it at a real provider and
the same path carries a real credential.
