# examples — the starter apps

Nine curated single-file Snug apps, built exactly the way the app-builder LLM is told to
build them (`packages/knowledge/prompts/knowledge-base/app-authoring/20-html-template.md`).
The playground bundles them as its "starter apps" shelf, loadable with no server and no key —
they degrade gracefully when the agent is a mock or unreachable.

| app | what it demos |
| --- | --- |
| [`chess/`](chess/) | JSON-only agent conversation with **local validation** — the app is the referee, the agent is a player with a personality |
| [`flying-pig/`](flying-pig/) | the origin-story arcade game — **LLM-free by design** (ADR-0011): pure local reflexes, high score via `usePersistedState` |
| [`habit-tracker/`](habit-tracker/) | **data ownership** — `useAppDB` writes a real SQLite file; ask a question, the agent answers with SQL that runs on *your* data |
| [`adventure-quest/`](adventure-quest/) | **both pillars at once** — the agent is the dungeon master, the pack + journal are SQLite tables, off-schema replies fall back to a local guide |
| [`quiz-me/`](quiz-me/) | **education wow** — the agent writes a five-question quiz on any topic; hard shape validation; built-in bank when keyless; scores in SQL |
| [`trivia-night/`](trivia-night/) | **multiplayer feeling, zero networking** — pass-and-play on one device, LLM-free, roster in SQL |
| [`trip-planner/`](trip-planner/) | **the family aspiration** — dream board, packing list, day plan; LLM-free, three SQL tables, export story |
| [`pocket-ledger/`](pocket-ledger/) | **solo-business rep** — income/expense in integer cents, SQL-summed totals, export-your-books story |
| [`connection-demo/`](connection-demo/) | **the connected path** — the only example that calls a real API through the governed seam; ships a `connection.json` the install act carries into the approval review, and shows the un-connected state honestly |

## The contract every app follows

- ONE self-contained `app.html`, ≤ 5 MB. React 18 UMD + Babel standalone from the CDN
  allowlist only (`cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`). Inline styles;
  no other external references (the sandbox blocks `connect-src`, and `img-src` is
  `data:`/`blob:` only — these apps draw their art with CSS).
- The **embedded hooks block** (`SnugBridge` + `useSnugApp` + `usePersistedState` +
  `useAppDB`) is copied **byte-identical** from `packages/sdk/embedded/snug-hooks.js` and
  ends at the `// 5. RESPONSE SCHEMA` banner. Never hand-edit it here — fix the SDK
  reference and re-copy.
- Announce metadata (`appId`/`displayName`/`description`/`iconEmoji`/`iconColor`), full
  state + `responseSchema` on every `sendMessage`, and defensive `ok:false` handling:
  errors are rendered, malformed replies get a graceful fallback, nothing crashes.
- No direct browser storage (`localStorage` et al. don't exist in a null-origin iframe) —
  persistence goes through the host-brokered `usePersistedState` / `useAppDB`.
- **No form elements.** The sandbox is `allow-scripts` only (no `allow-forms`), and the
  browser blocks a form submission BEFORE the `submit` event fires — an `onSubmit`
  handler never runs in a real browser even though it works in jsdom. Buttons use
  `onClick`; inputs accept Enter via `onKeyDown`. Enforced by the validate suite.
- **LLM posture declared (ADR-0011).** An LLM-free app sets `RESPONSE_SCHEMA = null` and
  never calls `sendMessage`; an agent-driven app always sends a `responseSchema` and
  degrades gracefully (visible fallback, never a crash) when the reply is off-schema —
  which is exactly what the keyless demo brain returns. Enforced by the validate suite.
- Design: theme-aware via the host `theme` (`data-theme` on `<html>`), both themes styled
  with custom properties, ≥44px touch targets, usable at 375px, no `window.confirm`, no
  hover-only affordances, skeletons over spinners.

## Validating

```sh
pnpm --filter examples test
```

Run it through the workspace, not directly. The suite imports `llmProposalSchema` from
`@snugprotocol/protocol` so the manifest rule enforces the *real* contract rather than a
restated copy that could drift — which means it needs that package **built**. Turbo's
`test → build → ^build` chain does that for you (verified: with `packages/protocol/dist`
deleted, `pnpm --filter examples test` rebuilds protocol first).

Running `node --test examples/validate.test.mjs` directly still works once protocol has
been built; on a fresh clone it fails loudly with `ERR_MODULE_NOT_FOUND`, which is
deliberate — a curation gate that quietly skipped its own checks would report success for
work it never did.

Asserts, per app: single-file with allowlisted-CDN-scripts-only, hooks block identical to
`packages/sdk/embedded/snug-hooks.js` (same normalization as the sdk kb-sync test),
announce fields present, no browser-storage usage, parses as HTML (jsdom when hoisted at
the root, structural checks otherwise), and the 5 MB limit.

## Adding an example

Start from the rendered KB template, keep the hooks block verbatim, put everything
app-authored after the `// 5. RESPONSE SCHEMA` banner (the validator uses that banner to
delimit the hook block), add a `README.md`, list the app in `APPS` in
`validate.test.mjs` (and in `LLM_FREE_APPS` if it never calls the agent), and run the
suite. The playground shelf picks the folder up automatically (vite glob) — give it a
look in `HubView`'s `STARTER_LOOKS` so the tile isn't the generic fallback.
