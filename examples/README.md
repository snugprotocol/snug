# examples — the starter apps

Three curated single-file Snug apps, built exactly the way the app-builder LLM is told to
build them (`packages/knowledge/prompts/knowledge-base/app-authoring/20-html-template.md`).
The playground bundles them as its "starter apps" shelf, loadable with no server and no key —
they degrade gracefully when the agent is a mock or unreachable.

| app | what it demos |
| --- | --- |
| [`chess/`](chess/) | JSON-only agent conversation with **local validation** — the app is the referee, the agent is a player with a personality |
| [`flying-pig/`](flying-pig/) | the origin-story arcade game — the agent as a **live game director** (dynamic difficulty + streamed taunts between runs) |
| [`habit-tracker/`](habit-tracker/) | **data ownership** — `useAppDB` writes a real SQLite file; ask a question, the agent answers with SQL that runs on *your* data |

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
- Design: theme-aware via the host `theme` (`data-theme` on `<html>`), both themes styled
  with custom properties, ≥44px touch targets, usable at 375px, no `window.confirm`, no
  hover-only affordances, skeletons over spinners.

## Validating

From the repo root (plain node ≥20, no build step — `examples/` is intentionally not a
workspace package):

```sh
node --test examples/validate.test.mjs
```

Asserts, per app: single-file with allowlisted-CDN-scripts-only, hooks block identical to
`packages/sdk/embedded/snug-hooks.js` (same normalization as the sdk kb-sync test),
announce fields present, no browser-storage usage, parses as HTML (jsdom when hoisted at
the root, structural checks otherwise), and the 5 MB limit.

## Adding an example

Start from the rendered KB template, keep the hooks block verbatim, put everything
app-authored after the `// 5. RESPONSE SCHEMA` banner (the validator uses that banner to
delimit the hook block), add a `README.md`, list the app in `APPS` in
`validate.test.mjs`, and run the suite.
