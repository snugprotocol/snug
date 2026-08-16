# Plan / Architecture

## Connected API (symbolic only — ADR-0026)
- Reads: `GET snug-connection://hue/clip/v2/resource/room`, `.../grouped_light`,
  `.../light` (lights are color detail only; a failed light read degrades to
  default-warm glows, never an error).
- Writes: `PUT snug-connection://hue/clip/v2/resource/grouped_light/{id}` with
  `{on, dimming, color|color_temperature}` — one write per room, host-confirmed
  (session-rememberable, which the UI copy teaches). No per-light writes at v1:
  every surface composes at room level, so grouped_light is the whole write surface.
- Room composition: room.services → grouped_light id (on/brightness);
  room.children (device rids) → member lights via light.owner.rid → averaged xy,
  else averaged mirek, for the tile glow.
- Error mapping is code-keyed: NET_NOT_APPROVED → unconnected; NET_FETCH_FAILED /
  NET_SSRF_BLOCKED → unreachable; NET_AMBIGUOUS_CONNECTION → its own state (never
  the pairing CTA); HTTP 401/403 → rejected (re-pair copy).

## Persistence
- `usePersistedState('hue-moodboard-ui')`: active tab only.
- SQL (`useAppDB`): one table —
  `moods(id INTEGER PK AUTOINCREMENT, name TEXT, source TEXT ('snapshot'|'designer'),
  narration TEXT NULL, rooms_json TEXT, created_at TEXT)`. Entries ride `rooms_json`
  as a JSON column (`{roomName, brightness, xy|mirek}` | `{roomName, off}`): a mood
  is applied atomically and read whole, so a child table would buy nothing. Corrupt
  rows parse to empty palettes, never crashes. All statements are literals at the
  call site with params arrays.

## Designer (the one agent turn)
- Lean request (ADR-0018): payload = `{request}`; `state.rooms` = live inventory
  (`name/on/brightness/mirek|xy`), nothing duplicated.
- `validateProposal`: shape errors reject whole (fallback shows narration as text);
  per-entry errors drop the entry and the preview names the dropped rooms; numbers
  clamped to bridge ranges (brightness 1-100, mirek 153-500, xy 0-1); rooms matched
  case-insensitively against real names, deduped.
- Preview costs nothing; apply/save are explicit taps; apply reuses the same
  sequenced-write path as saved moods.

## Color math
- CIE xy + brightness → sRGB via the Hue wide-gamut matrix; mirek → sRGB via the
  blackbody approximation. Used for tile glows (per-element `--room-glow` custom
  properties), swatches, and palette bands — the app *renders* light, it does not
  restate it as numbers.

## Deliberate omissions
- No scene resource usage (moods are the app's own, richer take), no per-light
  control, no polling (refresh on action + manual), no Hue setup flows — the vendor
  app owns those; Moodboard complements it.
