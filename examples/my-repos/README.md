# my repos

Your GitHub repositories at a glance, fetched by the **host** with a personal access token
this app never sees.

The `bearer_token` rung of the auth-spectrum shelf (AL-09 / roadmap A8b).

## Posture

| | |
|---|---|
| **Provider** | GitHub |
| **Credential kind** | `bearer_token` (a personal access token) |
| **Declared host** | `api.github.com` |
| **LLM posture** | **LLM-free** (ADR-0011): `RESPONSE_SCHEMA = null`, no `sendMessage` |

## Why `bearer_token` and not OAuth

The pinned registry has a `github` OAuth entry, so this starter could have been another
`oauth2_auth_code` app. It deliberately is not (AL-09 D2):

- A **personal access token** is a long-lived secret the user pastes. That is honestly the
  `bearer_token` kind, and modelling it as OAuth would misdescribe how the user actually
  holds it.
- It keeps the five starters spanning genuinely *different* credential shapes rather than
  shipping two near-identical OAuth flows.

The registry's `apiHosts` (`api.github.com`) is still the host authority — the declaration
does not get to invent its own (AC6).

This starter is also the proof vehicle for the kind: before AL-09, **no shipped test
instantiated a `bearer_token` spec** at all. That gap is now closed by a wizard test
covering field rendering, approval, and header-template injection.

## What it demonstrates

- **The governed seam.** Repos arrive through `net.fetch(url)`; the app has no network of
  its own (C2). The host injects the token and scrubs the reply.
- **An honest degraded state.** Before you connect, the app says plainly what it needs and
  why (`preconnect-notice`) rather than showing an empty list that looks like "no repos".
- **C1 in the authored code.** No token field, no `Authorization` header, no PAT string
  below the hooks block. The word "token" appears only in prose and error copy.

## Files

- `app.html` — the single-file app (hooks byte-synced to `packages/sdk/embedded/snug-hooks.js`).
- `connection.json` — the install-act declaration, validated against the real
  `llmProposalSchema` by `examples/validate.test.mjs`.

## Getting a token

Create a personal access token with **repo** scope. You paste it once into the approval
review; the host stores it in `snug_secrets` and injects it per request.

**Note:** the shipped tests never call the real API (AL-09 D3); they exercise the real
wizard, injection, and scrub path against a local stub.
