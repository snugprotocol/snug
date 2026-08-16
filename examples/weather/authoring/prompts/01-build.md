# build prompt — 2026-08-15, authored by Claude (Fable 5) for TASK-20260815-starter-apps-rebuild

===BRIEF-START===
# weather — "Should I?": forecasts turned into decisions

Build examples/weather/app.html — a single-file Snug starter, web + desktop. Complement every weather app, never clone one: they show you numbers; Should I? answers the question you actually had ("run at 6? bike tomorrow? water the garden tonight?").

OpenWeather API (query-string appid is INJECTED BY THE HOST — never put a key or appid param in your URLs): GET https://api.openweathermap.org/data/2.5/weather?lat=..&lon=..&units=metric, /data/2.5/forecast (5 day / 3 h), /geo/1.0/direct?q=<city>&limit=5 for geocoding.

Surfaces (desktop-first):
1. **Today** (default): current conditions for the active place rendered as a composed scene — CSS-drawn sky gradient + conditions (no images, no emoji-as-art beyond accents), a 24h best-window timeline strip (3h forecast slots colored by comfort score you compute locally: temp/wind/rain), sunrise/sunset arc.
2. **Decisions**: the signature surface. Decision cards the user creates ("evening run", "hang laundry", "cycle to work 8am") — each card shows a computed verdict chip (good/maybe/skip) from local rules over the forecast, and an "ask the agent" affordance: the app sends the card + relevant forecast slots; the agent replies {verdict, reason, bestWindow, tip} rendered into the card. Validate hard; off-schema → local verdict stands with a note. Decision cards + outcomes journal into the app DB (useAppDB) — a decision history no weather app keeps.
3. **Places**: saved places (geocoded once, stored in DB), quick compare strip (same hour across places).
4. Empty states teach the provider chat lane ("try asking: will Saturday morning stay dry in Olden?").

Un-connected: honest state explaining the free OpenWeather key + wizard, with a designed skeleton scene.
===BRIEF-END===
