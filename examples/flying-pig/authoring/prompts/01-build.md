*Reconstructed retrospectively (2026-08-21, TASK-20260821-hardening-polish): no verbatim prompt provenance exists for this starter — this page describes the build brief its code implies, so app-attached chat has honest context.*

# Build prompt — Flying Pig Feed!

- **Date:** unrecorded — the app pre-dates ADR-0035's authoring bundles
- **Model:** unrecorded
- **Supersedes:** nothing — first (and only) prompt of this app

The brief the code implies (not the owner's verbatim words):

---

Bring the origin-story flying-pig game — the one an eleven-year-old built in the
pre-Snug system — onto the starter shelf as a proper contract app. Keep it a game a
kid would love: bright, loud, instant.

You are building a slingshot arcade. Winged pigs cross the sky; the player presses,
drags to aim along a dotted arc, and releases to throw food at them. Give the foods
and the pigs personalities and point values, reward streaks with combo multipliers
and banners, cost a life for every pig that escapes, and level the game up as the
score climbs.

Make it entirely LLM-free (ADR-0011): declare `RESPONSE_SCHEMA = null` and never call
`sendMessage` — every reflex, spawn and score is local, because a round trip would
only add latency to a game about instant response. Still honor the handshake:
announce, wait for host-ready, and hydrate the persisted high score through the
bridge before first paint.

Respect the sandbox: no image files and no audio files — draw with emoji and CSS
gradients, synthesize every sound with WebAudio (and give the music a toggle). One
self-contained `app.html`, scripts only from the CDN allowlist, touch and mouse
equally first-class.

And make the game watch the player back: measure accuracy, feed it into pig speed,
and show the meter so the player knows why the pigs got faster.
