# crypto portfolio

What your coins are worth, with live CoinGecko prices fetched by the **host** using
**your** free demo key — which this app never sees.

The `api_key` rung of the auth-spectrum shelf (AL-09 / roadmap A8b).

## Posture

| | |
|---|---|
| **Provider** | CoinGecko |
| **Credential kind** | `api_key` (free-tier **demo** key) |
| **Declared host** | `api.coingecko.com` |
| **LLM posture** | **LLM-free** (ADR-0011): `RESPONSE_SCHEMA = null`, no `sendMessage` |

## Why a key at all, when CoinGecko has a free endpoint

The umbrella originally sketched this starter as "none/CoinGecko" — a keyless connected
app. That collides head-on with the 1.0 spec: the credential union has exactly five kinds,
none of them keyless, and the runtime is fail-closed. Rather than invent a spec-level
`none` kind to make one demo convenient, this ships as a normal `api_key` starter against
CoinGecko's free **demo** keys.

That is not a workaround — it is what the shipped knowledge base already teaches:

> When the user's request can be served by a provider that issues API keys — including
> free-tier keys — prefer that provider and declare it normally.

A spec-level keyless kind stays queued for post-alpha (AL-09 D1).

## What it demonstrates

- **The governed seam.** Prices come through `net.fetch(url)`; the app has no network of
  its own (C2). The host checks the host allowlist, injects your key, and scrubs the reply.
- **A genuinely useful degraded state.** Before you connect, your holdings are still
  editable — the ± controls work, the layout is real, only the prices are missing
  (`preconnect-notice`). The un-connected state is where every new user starts.
- **C1 in the authored code.** No key field, no `Authorization` header, no api-key string
  below the hooks block.

## Files

- `app.html` — the single-file app (hooks byte-synced to `packages/sdk/embedded/snug-hooks.js`).
- `connection.json` — the install-act declaration, validated against the real
  `llmProposalSchema` by `examples/validate.test.mjs`.

Holdings live in component state only — no browser storage, per the starter contract.

**Note:** the shipped tests never call the real API (AL-09 D3); they exercise the real
wizard, injection, and scrub path against a local stub.
