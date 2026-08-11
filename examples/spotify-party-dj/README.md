# spotify party dj

Build the party queue from your own Spotify playlists. You sign in **with Spotify** — the
host keeps the session, and this app never sees it.

The `oauth2_auth_code` rung of the auth-spectrum shelf (AL-09 / roadmap A8b).

## Posture

| | |
|---|---|
| **Provider** | Spotify (in the pinned registry) |
| **Credential kind** | `oauth2_auth_code` + PKCE, with BYO dev registration |
| **Declared host** | `api.spotify.com` |
| **LLM posture** | **LLM-free** (ADR-0011): `RESPONSE_SCHEMA = null`, no `sendMessage` |

## What makes this one different

Spotify **is** in the pinned provider registry, so the authorize and token endpoints and
the API host come from **registry values** rather than from anything this app declares. A
declaration cannot borrow a trusted brand's endpoints for itself — that host-side
resolution is the point, not an implementation detail.

You bring your **own developer registration**. The walkthrough for that lives in the
registry (`WELL_KNOWN_PROVIDERS_REGISTRY.spotify.registration`), never in this app's copy
and never in wizard components — provider-specific instructions rendered by the wizard
carry wizard-grade legitimacy, so they must come from reviewed, in-repo data (AL-04 D5,
AL-09 AC10).

## What it demonstrates

- **A real OAuth round trip** ending in your own playlists, with PKCE as the default.
- **The governed seam.** Playlists arrive through `net.fetch(url)`; the app has no network
  of its own (C2).
- **A useful degraded state.** The party queue is live and buildable the moment playlists
  arrive, and before connecting the app says exactly what will happen — *approving sends
  you to Spotify to sign in* (`preconnect-notice`).
- **C1 in the authored code.** No client secret, no access token, no `Authorization`
  header below the hooks block. The entire token dance happens host-side.

## Files

- `app.html` — the single-file app (hooks byte-synced to `packages/sdk/embedded/snug-hooks.js`).
- `connection.json` — the install-act declaration, validated against the real
  `llmProposalSchema` by `examples/validate.test.mjs`.

The queue is component state only — no browser storage, per the starter contract.

**Note:** the shipped tests never call the real API (AL-09 D3); they exercise the real
wizard, injection, and scrub path against a local stub.
