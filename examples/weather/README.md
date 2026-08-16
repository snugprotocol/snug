# weather — "Should I?": forecasts turned into decisions

**What it demos:** the full connected + agent-driven story in one starter — live
OpenWeather data (current, 5-day/3-hour forecast, geocoding) through the governed
connected-fetch seam, decision verdicts computed by local, explainable rules, an
"ask the agent" upgrade validated hard against `RESPONSE_SCHEMA`, and app-owned
SQLite for places, decision cards, and a decision-outcome journal.

**Complement thesis:** every weather app shows you numbers; none answers the
question you actually had. *Should I?* turns the forecast into verdicts — decision
cards ("evening run", "hang laundry", "water the garden tonight") each carrying a
good / maybe / skip chip, a best-window read, and an outcome journal no weather
app keeps. It complements the forecast apps on your phone; it never clones them.

**Connection posture:** slot `openweather`, kind `api_key`. The key is stored
host-side by the connection wizard and injected as the `appid` **query parameter**
on every request — the app's URLs never contain it and the iframe never sees it
(C1). OpenWeather's API serves CORS, so the starter works on **web and desktop**
alike. Un-connected installs get an honest designed dead-end (skeleton scene, the
free-key steps, no fake numbers); 401s explain key activation lag, 429s explain
the free-tier rate limit.

**LLM posture:** agent-driven — non-null `RESPONSE_SCHEMA`, a `responseSchema` on
every `sendMessage`, and the runtime contract in
[`runtime-contract.json`](runtime-contract.json). The app is the referee: replies
are validated hard (verdict enum + required reason; bounded optional fields), and
a failed or off-schema reply — the keyless demo brain's canned answer is exactly
that — leaves the locally computed verdict standing with a visible note. Local
verdicts only, stated honestly; nothing is ever faked.

**Authoring provenance:** built 2026-08-15 for TASK-20260815-starter-apps-rebuild;
the build prompt and short authoring wiki ship in [`authoring/`](authoring/).
