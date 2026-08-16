# Plan / Architecture

## Structure
One file, chess-idiom layout: verbatim `snug-hooks.js` block, the section-5
`RESPONSE_SCHEMA` banner, then app code. Four surfaces behind a tab row
(`Portrait | Trends | Now | Ask`), each a plain component fed props from `App`.

## Connected API (host `api.spotify.com`, slot `spotify`)
- `GET /v1/me/top/tracks|artists?time_range=…&limit=50` — portrait per range, cached
  per range in memory for the session; all-time artists double as the discovery canon.
- `GET /v1/me` — display name for the greeting (non-blocking, silent on failure).
- `GET /v1/me/player/recently-played?limit=50` — attempted ONCE per session.
- `GET /v1/me/player` — Now surface; 15s poll only while that surface is open.
- `PUT /v1/me/player/play|pause`, `POST /v1/me/player/next|previous` — governed
  writes; the host confirms each; app refreshes player state ~900ms after success.

## Decision: the recently-played scope gap
The registry pin (ADR-0028, `well-known-providers.ts`) grants 7 read+playback scopes
but NOT `user-read-recently-played`, so the brief's recent-plays lane 403s under every
token this connection can mint. Decision: attempt it once per session (it is a cheap,
declared-host GET), treat the 403 as `unavailable`, caption the discovery stat with the
truth, and compute discovery from top-list drift (period top-20 vs all-time top-50)
instead. If a future pin adds the scope, the richer lane lights up with no code change.

## Metrics (defined once, journaled with the same meaning)
- `rotationDepth(tracks)` = share of top-50 tracks whose primary artist is one of the
  3 most frequent artists in that list. Null under 5 tracks.
- `discoveryVsCanon(artists, canon)` = share of the period's top-20 artists whose id is
  absent from the all-time top-50 id set. Null on the all-time lens or if the canon
  fetch failed.

## App DB schema (useAppDB)
```sql
CREATE TABLE IF NOT EXISTS rewind_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,              -- local YYYY-MM-DD; UNIQUE via index
  top_artists TEXT NOT NULL,      -- JSON [{id,name}] x5
  top_tracks TEXT NOT NULL,       -- JSON [{id,name,artist}] x5
  rotation_depth REAL NOT NULL,   -- 0..1
  discovery_ratio REAL,           -- 0..1, NULL when the canon was unavailable
  taken_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rewind_snapshots_day ON rewind_snapshots (day);
```
Journaling: once per session, only from a successful short-term load (consistent
semantics across days regardless of the lens being viewed), one row per day with the
latest visit winning (literal `DELETE` + `INSERT`, params arrays, no string-built SQL).
The journal is also the offline fallback: un-connected or failed loads render the
latest snapshot, labeled with its capture date.

## Persisted KV (usePersistedState)
- `rewind-prefs` — `{ range }` (selected time lens).
- `rewind-last-card` — the last valid rewind card `{ card, at, range }`.

## Agent turn
One action, `weekly_rewind`. Payload is a one-line ask; ALL substance rides `state`
(lean-runtime, ADR-0018): range label, top-5 lists with ranks, both metric percentages
with their meanings spelled out, optional recent-plays stats, nowPlaying, and journal
facts (visit count, previous top artist). Reply validated by `validateRewind` — typed,
trimmed, length-capped, highlights 1..4 — and anything less is a notice, not content.
`maxOutputTokens` left out of the contract on purpose (brief fixed the field list).

## Design
One accent (violet `#6b3fd4` light / `#a685f0` dark), serif display for the brand and
magazine card, every theme color in `:root` / `:root[data-theme="dark"]` custom
properties. Tile art is data-driven inline `hsl()` from a string hash — content, not
theme. Desktop: 5-across tile grids inside a 1020px column; ≤760px the grids reflow to
auto-fill 104px tiles and the portrait head stacks; ≤420px paddings tighten.
