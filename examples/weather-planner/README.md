# weather planner

Pick a city, see the week. A five-day forecast from OpenWeather, fetched by the **host**
with **your** key — which this app never sees.

This is the `api_key` rung of the auth-spectrum shelf (AL-09 / roadmap A8b): one starter
per credential shape, so the connect → approve → inject → scrub path is something you can
watch happen rather than take on trust.

## Posture

| | |
|---|---|
| **Provider** | OpenWeather (named, not endpoint-guessed) |
| **Credential kind** | `api_key` |
| **Declared host** | `api.openweathermap.org` — the only host it may dial |
| **LLM posture** | **LLM-free** (ADR-0011): `RESPONSE_SCHEMA = null`, no `sendMessage` |

LLM-free is deliberate. The connected forecast *is* the demo, and a model in the loop
would blur it — you could not tell whether the numbers on screen came off the wire or out
of a sentence generator.

## What it demonstrates

- **The governed seam, really called.** Every request goes through `net.fetch(url)` — a
  method on the handle `useConnectedFetch()` returns. The app has no network of its own
  (`connect-src` is blocked, C2), so this is the only way out: the host checks the URL
  against the declared host list, injects your key, blocks private addresses, caps the
  size, and returns a scrubbed body.
- **The install-act declaration.** This folder ships a `connection.json`. Installing the
  app carries that declaration into the **same strong, field-by-field approval review**
  a builder-LLM proposal gets — it only *prefills* the review, it never shortens it
  (ADR-0016). That is why a chat-less starter can be connected at all.
- **An honest degraded state.** Before you connect, the city picker still works and the
  app says plainly what it needs and why (`preconnect-notice`). The un-connected state is
  where every new user starts, so a blank screen or dead spinner there would be the whole
  demo failing.
- **C1 in the authored code.** There is no key field, no `Authorization` header, and no
  api-key string anywhere in the region below the hooks block. Grep it and see.

## Files

- `app.html` — the single-file app (hooks block byte-synced to `packages/sdk/embedded/snug-hooks.js`).
- `connection.json` — the declared connection: provider `OpenWeather`, host
  `api.openweathermap.org`. Validated against the real `llmProposalSchema` by
  `examples/validate.test.mjs`, the same contract the directive channel uses.

## Getting a key

OpenWeather issues free-tier keys that cover the five-day forecast endpoint this app
calls. You paste it once into the approval review; the host stores it in `snug_secrets`
and injects it per request. It is never handed to this page and never reaches a model.

**Note:** the shipped tests never call the real API (AL-09 D3) — they exercise the real
wizard, injection, and scrub path against a local stub. Verification against live
OpenWeather traffic is queued in `docs/next-steps.md`, not silently claimed here.
