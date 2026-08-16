# Requirements

- **Portrait (default surface):** top-5 tracks and top-5 artists for a selected time
  range (`short_term` / `medium_term` / `long_term` as a segmented control, persisted),
  rendered as CSS gradient tiles hashed from the track/artist identity — no images.
  Two computed stats with meters: rotation depth (share of the top-50 tracks held by
  the top 3 artists) and discovery (share of the period's top-20 artists absent from
  the all-time top 50; shown as "—" on the all-time lens, with the reason).
- **Recently-played lane:** attempted once per session. The registry scope pin omits
  `user-read-recently-played`, so the expected 403 is handled as a *labeled* degrade —
  the discovery caption says the play-by-play scope is missing and that drift between
  top lists is used instead. If the scope is ever granted, repeat/fresh-face chips
  appear from the real last-50 plays.
- **Trends:** every successful visit journals one compact snapshot per day (latest
  wins) into the app's SQLite: top-5 artist/track ids+names, rotation depth, discovery.
  The page renders discovery-over-time bars, rotation-over-time bars, and a "#1 seat"
  list with same-artist streak badges. Honest empty state before the first snapshot.
- **Now:** current playback from `/v1/me/player` (204 → honest "nothing playing"
  state), CSS-art tile, live-ticking progress bar, play/pause/previous/next via
  PUT/POST. Copy states plainly that each control is a governed write the hub confirms.
  404 → "no active device" guidance; 403 → Premium-required guidance. Poll 15s while
  the surface is open, never in the background.
- **Ask:** four copyable sample prompts for the app's chat lane, each labeled with its
  data lane (read vs governed write) and why it works; clipboard write with an honest
  select-the-text fallback when the sandbox refuses the clipboard.
- **Weekly rewind (the agent turn):** `sendMessage('weekly_rewind', …)` with
  `RESPONSE_SCHEMA` and full compact stats in `state`; reply validated hard
  (headline/story/highlights, typed, trimmed, capped); valid card persisted and
  rendered magazine-style; `ok:false` and off-schema replies become visible notices
  with retry — never rendered content, never a crash.
- **Un-connected state:** explains what connects and why it's safe, shows a skeleton
  preview explicitly labeled as shape-only, never fake data; falls back to the app's
  own journaled portrait (labeled with its capture date) when one exists.
- **Failure honesty:** 401 → connect guidance; 403 → dev-mode-allowlist/Premium
  guidance (the connection itself is fine); 429 → rate-limit guidance; `{ok:false}` →
  the hub-side message. Retry is always a user action, never a loop.
- **Theme/layout:** every color a custom property under `:root` and
  `:root[data-theme="dark"]`; desktop-first composition that stacks cleanly at 375px;
  ≥44px touch targets; skeletons over spinners throughout.
