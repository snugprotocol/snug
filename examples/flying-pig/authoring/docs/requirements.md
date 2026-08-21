# Requirements

Owner requirements, restated as musts (reconstructed from the shipped code — see
prompts/01-build.md for provenance):

1. Must be the origin-story game as a starter-shelf keeper: a kid-friendly arcade a
   player can pick up from one hint line ("press & drag to aim — release to throw").
2. Must be entirely LLM-free (ADR-0011): `RESPONSE_SCHEMA = null` and authored code
   that never calls `sendMessage`, with the validate suite's posture lint enforcing
   both — the shelf's proof that an app owes the model nothing.
3. Must still honor the full handshake: announce on mount, first paint gated on
   host-ready — an LLM-free app is a contract app, not an exception.
4. Must persist the high score in the user's own file — host-brokered key-value via
   `usePersistedState`, because the sandbox's null origin has no browser storage.
5. Must play equally on touch and mouse: press-drag-release slingshot aiming, one
   pointer path for both, `clamp()`-sized chrome, no pinch zoom.
6. Must feel juicy: combo chains with banners, score popups, hit stars, level-up
   fanfares — and every sound synthesized in WebAudio (oinks, splats, a looping
   melody with a toggle), since no audio file can ship.
7. Must scale difficulty with the player: pig speed follows measured accuracy and
   level, shown live on a meter, so a good shot makes the next pig faster.
8. Must ship as one self-contained `app.html`: emoji and CSS gradients for all art,
   scripts only from the fixed CDN allowlist, no other network anywhere.

Hard boundaries: no model call in any code path — the agent's role ended at authoring
time; no direct network APIs (the validate lint's rule pair); no browser storage —
persistence is host-brokered only; nothing outside the single file.
