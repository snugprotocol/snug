# build prompt — 2026-08-15, authored by Claude (Fable 5) for TASK-20260815-starter-apps-rebuild

===BRIEF-START===
# hue — "Moodboard": rooms, light, and the agent as lighting designer

Build examples/hue/app.html — a single-file Snug starter, desktop-only (LAN bridge). Complement the Philips Hue app, never clone it: Hue's app is switches and sliders; Moodboard treats light as MOOD — composed, named, remembered — with the agent as your lighting designer.

CRITICAL ADDRESSING RULE: every request uses symbolic URLs — useConnectedFetch to `snug-connection://hue/clip/v2/resource/...` — NEVER an IP address, never http(s)://<anything> for the bridge, never asking the user for an address. The hub resolves the bridge; the app never knows it. Hue CLIP v2 API: GET /clip/v2/resource/room, /clip/v2/resource/grouped_light, /clip/v2/resource/light, /clip/v2/resource/scene; PUT /clip/v2/resource/grouped_light/{id} and /light/{id} with {"on":{"on":true},"dimming":{"brightness":..},"color":{"xy":{...}}}. Writes are governed: the host confirms each PUT (session-rememberable) — design copy accordingly.

Surfaces (desktop-first):
1. **Rooms** (default): every room as a large elegant tile — CSS-drawn light glow reflecting current on/brightness/color state, one-tap on/off, a refined brightness slider and a curated color-temperature/color swatch row (design the swatches; no color-picker widgets). Batch select rooms.
2. **Moods**: composed looks — a mood = per-room brightness+color set. Save moods into the app DB (useAppDB), apply with one tap (sequenced PUTs), preview the palette as a CSS composition. Ship 4 tasteful built-in moods (e.g. Candlelight, Focus, Dusk, Cinema) that adapt to whatever rooms exist.
3. **Designer** (agent): describe a feeling ("golden hour in the study", "match everything to a quiet rainy evening") → the app sends room inventory + request; the agent replies {mood: {name, rooms: [{roomName, brightness, colorXy|mirek}], narration}} — validated hard; the app previews the palette FIRST, then applies on the user's tap (the host still confirms the writes). Off-schema → graceful fallback with the narration as text. Also teach provider-lane chat prompts in an empty-state hint ("try: set every lamp except the bedroom to 20%").

Un-connected state: honest and beautiful — explain the bridge pairing happens in the connection wizard, render a skeleton room grid, desktop-only note.
===BRIEF-END===
