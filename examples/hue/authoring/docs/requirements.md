# Requirements

- Single-file `app.html`; exactly the three allowlisted CDN scripts + one babel
  script; hooks block byte-identical to `packages/sdk/embedded/snug-hooks.js`.
- Every bridge request symbolic: `snug-connection://hue/clip/v2/resource/...` — no IP
  literals, no bridge hostnames, anywhere in the file.
- **Rooms** (default surface): one tile per real room from `GET .../room` +
  `.../grouped_light` + `.../light`; CSS glow reflecting live on/brightness/color;
  one-tap on/off; debounced brightness slider; 8 curated swatches (4 color
  temperatures, 4 colors); batch select with a floating batch bar (on/off, four
  levels, swatches).
- **Moods**: save/apply/delete moods in app SQL (`moods` table, entries as a JSON
  column); "save current look" snapshot (captures off rooms as `off: true`); 4
  built-in recipes (Candlelight, Focus, Dusk, Cinema) that adapt to whatever rooms
  exist; palette previewed as a CSS gradient band; apply = sequenced governed
  grouped_light PUTs with progress + honest partial-failure toasts.
- **Designer**: `sendMessage('design_mood', {request}, {state:{rooms}, responseSchema})`;
  reply validated hard (shape rejection → narration-as-text fallback; unknown rooms
  dropped and named; brightness/mirek/xy clamped to bridge ranges); preview first,
  apply and save only on tap; empty-state example chips + provider-chat-lane hints.
- Un-connected and unhappy states, each distinct: `NET_NOT_APPROVED` → wizard-pointing
  pairing copy over a skeleton grid + desktop-only note; `NET_FETCH_FAILED` /
  `NET_SSRF_BLOCKED` → "bridge didn't answer"; `NET_AMBIGUOUS_CONNECTION` → its own
  configuration message, never the pairing CTA; HTTP 401/403 → re-pair copy.
- Theme via CSS custom properties under `:root` / `:root[data-theme="dark"]` only;
  no `prefers-color-scheme`; ≥44px targets; usable at 375px, composed on desktop.
- No browser storage, no `<form>`, no `window.confirm`, params arrays on all SQL.
