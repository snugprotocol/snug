# Requirements

- Single-file `app.html` per the app-authoring contract: three CDN UMD scripts, one
  babel script, embedded hooks block byte-identical to `packages/sdk/embedded/snug-hooks.js`.
- All network through `useConnectedFetch` against `api.openweathermap.org` only
  (`/data/2.5/weather`, `/data/2.5/forecast`, `/geo/1.0/direct`), `units=metric`,
  never an `appid` parameter — the host injects the key query-side.
- **Today**: CSS-drawn scene (sky gradient by condition + day/night, sun/moon,
  clouds, animated rain/snow overlays — no images), current numbers on a scrim,
  sunrise/sunset SVG arc with daylight length, 24-hour timeline of eight 3-hour
  slots colored by a locally computed comfort score, best-stretch callout.
- **Decisions**: cards with title, kind (outdoor effort / needs dry hours / skip if
  rain is coming), and window (today/tomorrow presets); local verdict chip
  (good/maybe/skip) with a one-line reason and best window; "ask the agent" sends
  card + relevant slots with `responseSchema`, validates the reply hard, and an
  off-schema/failed reply leaves the local verdict standing with a visible note;
  outcomes ("I did it" / "I passed") journal to SQLite; journal list rendered.
- **Places**: geocode-once search (limit 5), saved places in SQLite, active-place
  chips in the header, same-hour compare strip across saved places.
- Honest degraded states: un-connected hero (free-key steps + designed skeleton
  scene, no fake data), 401 key-activation copy, 429 rate-limit copy, stale-data
  notice when a refresh fails but an older forecast exists.
- Empty states teach the provider chat lane ("will Saturday morning stay dry in Olden?").
- Theme via CSS custom properties under `:root` / `:root[data-theme="dark"]` only;
  no `prefers-color-scheme`; ≥44px targets; skeletons; usable at 375px, composed on desktop.
