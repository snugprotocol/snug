# examples — the starter apps

Ten curated single-file Snug apps, built exactly the way the app-builder LLM is told to
build them (`packages/knowledge/prompts/knowledge-base/app-authoring/20-html-template.md`).
The playground bundles them as its "starter apps" shelf, loadable with no server and no
key — they degrade gracefully when the agent is a mock or unreachable.

Curated 2026-08-15 (TASK-20260815-starter-apps-rebuild, ADR-0031): five keepers plus
five **gold-standard connected starters** — each complements its provider's own app
rather than cloning it, exploits the provider chat lane (ask the app's chat about the
connected service; the host composes and governs the API calls), and ships its
authoring provenance in `authoring/` (the dev-time prompts plus the same wiki pages the
hub keeps for user-built apps — vision, requirements, plan, lessons).

| app | what it demos |
| --- | --- |
| [`chess/`](chess/) | JSON-only agent conversation with **local validation** — the app is the referee, the agent is a player with a personality |
| [`flying-pig/`](flying-pig/) | the origin-story arcade game — **LLM-free by design** (ADR-0011): pure local reflexes, high score via `usePersistedState` |
| [`adventure-quest/`](adventure-quest/) | **both pillars at once** — the agent is the dungeon master, the pack + journal are SQLite tables, off-schema replies fall back to a local guide |
| [`quiz-me/`](quiz-me/) | **education wow** — the agent writes a five-question quiz on any topic; hard shape validation; built-in bank when keyless; scores in SQL |
| [`trivia-night/`](trivia-night/) | **multiplayer feeling, zero networking** — pass-and-play on one device, LLM-free, roster in SQL |
| [`trade-copilot/`](trade-copilot/) | **the flagship connected app** — ported from the owner's own hub-built Coinbase copilot: live portfolio through Ed25519 per-request signing (ADR-0030), an agent grounded in real positions, desktop-only |
| [`spotify/`](spotify/) | **your listening, understood** — portraits + trends the provider's app doesn't keep, journaled locally; playback control through governed writes |
| [`hue/`](hue/) | **the LAN-class starter** — rooms and agent-composed moods over `snug-connection://hue/…` symbolic addressing (ADR-0026); the bridge address never enters the app |
| [`weather/`](weather/) | **forecasts turned into decisions** — OpenWeather (query-key injected host-side) + agent verdict cards with a local decision history |
| [`github/`](github/) | **what needs you, before you ask** — review queue + activity pulse + an agent morning briefing; label/triage actions ride confirmed writes |

## The contract every app follows

- ONE self-contained `app.html`, ≤ 5 MB. React 18 UMD + Babel standalone from the CDN
  allowlist only (`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`). Inline styles;
  no other external references (the sandbox blocks `connect-src`, and `img-src` is
  `data:`/`blob:` only — these apps draw their art with CSS).
- The **embedded hooks block** (`SnugBridge` + `useSnugApp` + `usePersistedState` +
  `useAppDB` + `useConnectedFetch`) is copied **byte-identical** from
  `packages/sdk/embedded/snug-hooks.js` and ends at the `// 5. RESPONSE SCHEMA` banner.
  Never hand-edit it here — fix the SDK reference and re-copy.
- Announce metadata (`appId`/`displayName`/`description`/`iconEmoji`/`iconColor`), full
  state + `responseSchema` on every `sendMessage`, and defensive `ok:false` handling:
  errors are rendered, malformed replies get a graceful fallback, nothing crashes.
- No direct browser storage (`localStorage` et al. don't exist in a null-origin iframe) —
  persistence goes through the host-brokered `usePersistedState` / `useAppDB`. Network
  goes ONLY through `useConnectedFetch` to declared hosts (or `snug-connection://` for
  LAN-class slots) — never `fetch`/`XMLHttpRequest`/`WebSocket` in authored code.
- **No form elements.** The sandbox is `allow-scripts` only (no `allow-forms`), and the
  browser blocks a form submission BEFORE the `submit` event fires — an `onSubmit`
  handler never runs in a real browser even though it works in jsdom. Buttons use
  `onClick`; inputs accept Enter via `onKeyDown`. Enforced by the validate suite.
- **LLM posture declared (ADR-0011).** An LLM-free app sets `RESPONSE_SCHEMA = null` and
  never calls `sendMessage`; an agent-driven app always sends a `responseSchema`, ships a
  `runtime-contract.json` (pinned to the version at install), and degrades gracefully
  (visible fallback, never a crash) when the reply is off-schema — which is exactly what
  the keyless demo brain returns. Enforced by the validate suite.
- **Connected apps declare via `connection.json`** — the install-act channel (always the
  strong field-by-field review; registry borrows arrive pinned). The five declarers are
  count-pinned in `connection-manifests.test.mjs`.
- **Authoring provenance in `authoring/`** (the connected five): `prompts/` holds the
  verbatim dev-time build prompts (+ `00-assembly.md` naming the KB assembly),
  `docs/` holds the standard wiki slugs (`vision`, `requirements`, `plan`, …) —
  file-per-slug, 1:1 with `snug_app_docs`, so a future phase can ingest them.
- Design: theme-aware via the host `theme` (`data-theme` on `<html>`), both themes styled
  with custom properties, ≥44px touch targets, usable at 375px, no `window.confirm`, no
  hover-only affordances, skeletons over spinners.

## Validating

```sh
pnpm --filter examples test
```

Run it through the workspace, not directly. The suite imports from
`@snugprotocol/protocol` so the manifest rule enforces the *real* contract rather than a
restated copy that could drift — which means it needs that package **built**. Turbo's
`test → build → ^build` chain does that for you.

Asserts, per app: single-file with allowlisted-CDN-scripts-only, hooks block identical to
`packages/sdk/embedded/snug-hooks.js` (same normalization as the sdk kb-sync test),
announce fields present, no browser-storage usage, no direct network APIs, parses as HTML,
honest LLM posture + runtime-contract presence, the 5 MB limit — plus the hue
real-connection pins (symbolic URLs, no private-address literals).

## Adding an example

Start from the rendered KB template, keep the hooks block verbatim, put everything
app-authored after the `// 5. RESPONSE SCHEMA` banner (the validator uses that banner to
delimit the hook block), add a `README.md`, list the app in `APPS` in
`validate.test.mjs` (and in `LLM_FREE_APPS` if it never calls the agent), update
`MANIFEST_APPS` in `connection-manifests.test.mjs` if it declares a connection, and run
the suite. The playground shelf picks the folder up automatically (vite glob) — give it
a look in `HubView`'s `STARTER_LOOKS` so the tile isn't the generic fallback.
