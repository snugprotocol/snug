# Plan / Architecture

## Persistence
- `usePersistedState('should-i-prefs')`: `{ activePlaceId }` — tiny UI state only.
- SQL (`useAppDB`), literal DDL + params arrays everywhere:
  - `places(id, name, region, country, lat, lon, added_at)` — geocoded once, never re-queried.
  - `decisions(id, title, kind, emoji, day_offset, start_hour, end_hour, created_at)`.
  - `journal(id, decision_id, title, place, verdict, source, reason, outcome, decided_at)` —
    denormalized title/place so history survives card and place deletion.

## Connected API (slot `openweather`, host `api.openweathermap.org`)
- `GET /data/2.5/weather?lat&lon&units=metric` — scene, sunrise/sunset, compare strip.
- `GET /data/2.5/forecast?lat&lon&units=metric` — 40 three-hour slots for verdicts + timeline.
- `GET /geo/1.0/direct?q&limit=5` — place search, saved once to SQL.
- Fetch on ready/place-change/manual refresh only (no polling — free-tier friendly);
  failures classified into unconnected (`NET_NOT_APPROVED`) / key (401) / rate (429) /
  net, each with its own honest copy; stale data stays visible and is labeled.

## Local rules
- Per-slot comfort score 0–100 by kind: 'active' (feels-like band 12–22°, wind, pop,
  rain/snow), 'dry' (pop and humidity dominate; a breeze helps), banded ≥70 good /
  ≥45 maybe / else skip. 'water' inverts: sums the next 24 h of rain — rain coming
  means skip (the sky waters it).
- Window = stored hour range on today/tomorrow; 'dry' judges the worst slot, 'active'
  the best; a passed window falls forward to tomorrow with a note. Reasons name the
  dominant factor ("72% chance of rain around 18:00").

## Agent turn (ADR-0018 lean)
One action `should_i`: payload = decision + localVerdict; `state` = place + up to 8
compact window slots. `RESPONSE_SCHEMA` = {verdict, reason, bestWindow?, tip?};
`validateAdvice` enforces the enum + required reason with length caps. Failure or
off-schema → local verdict stands, note rendered. Contract in `runtime-contract.json`
(overview / stateGuidance / responseGuidance / maxOutputTokens 300).

## Timezones
All slot math uses the place's own offset from the API (`timezone` seconds): shift the
epoch, read UTC fields — browser-local timezone never touches verdict windows.
