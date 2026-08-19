# hue — "Moodboard": rooms, light, and the agent as lighting designer

**What it demos:** the LAN-class connected story end to end — a device the app can
never address directly (a Philips Hue bridge on the user's own network), driven
entirely through symbolic connection-relative URLs
(`snug-connection://hue/clip/v2/resource/...`, ADR-0026), with the agent in a real
creative role: a lighting designer that turns "golden hour in the study" into a
validated, previewable, per-room plan. Plus app-owned SQLite (saved moods), batch
room control, and honest fallbacks for every bridge state.

**Complement thesis:** the Philips Hue app is switches and sliders; Moodboard never
clones it. It treats light as MOOD — composed, named, remembered. Rooms render as
glowing tiles (state as light, not as toggles-with-labels), looks are saved as moods
and re-applied in one tap, and the designer surface gives the model the one job a
settings screen cannot do: composition.

**Connection posture:** slot `hue`, kind `api_key`, LAN-class (`lanHost` manifest —
see [`connection.json`](connection.json)). The manifest pins NO host: the bridge's
address is the user's fact, collected by the connection wizard, which also walks the
round-button pairing and pins the bridge's self-signed certificate on first use
(TOFU). The app addresses the *connection*, never a host — every request is a
symbolic `snug-connection://hue/...` URL the host resolves, so no address (and no
RFC-1918 literal) exists anywhere in the app. Desktop-only by nature: private-network
devices resolve from the Snug desktop app; the browser build refuses private ranges.
Writes (`PUT .../grouped_light/{id}`) are governed — the host confirms each one, and
a session grant collapses a whole mood into a single yes.

**LLM posture:** agent-driven — `RESPONSE_SCHEMA` non-null, `responseSchema` on every
`sendMessage`, runtime contract in [`runtime-contract.json`](runtime-contract.json).
The agent's reply is validated hard (unknown rooms dropped, numbers clamped to the
bridge's legal ranges); off-schema replies degrade to narration-as-text and nothing
is staged. Keyless/unpaired, the app stays whole: a lit sample home (see below),
wizard-pointing copy, built-in moods previewing against the sample rooms, and full
manual control the moment the bridge answers.

**App DB:** one table — `moods(id, name, source, narration, rooms_json, created_at)`;
`rooms_json` holds the per-room entries (`{roomName, brightness, xy|mirek}` or
`{roomName, off}`) as a JSON column, applied atomically as sequenced grouped_light
writes.

## Sample mode

Before a bridge is paired (and in every unlinked bridge state), Moodboard renders a
clearly-bannered **sample home** instead of a skeleton: five made-up rooms caught
mid-evening — Living Room in dusk amber at 45%, Office at day-white 100%, Bedroom in
candle glow at 18%, Kitchen off, a rose-lit Reading Nook — as the same glowing tiles
a real house gets, with the built-in moods previewing against them and one canned
designer look ("Movie Night") standing in under *your moods*. The dataset is a fixed
authored constant (the `HUE-SAMPLE-BEGIN/END` block): deterministic, render-only,
never written to the moods table, never sent to the designer, and incapable of
reaching the bridge (`groupedLightId: null`). The first successful link replaces it
wholesale — the moment the bridge answers with your rooms, the sample home unmounts
and never renders again while the bridge is linked.

Authoring provenance lives in [`authoring/`](authoring/): the verbatim build prompt
and the short vision / requirements / plan docs.
