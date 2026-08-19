# Next tasks

- Mood transitions: CLIP v2 grouped_light accepts `dynamics.duration` — a mood that
  fades in over a few seconds instead of snapping would deepen the "composed light"
  feel at near-zero write cost.
- Scene import: read the bridge's native scenes as starting palettes for the moods
  library (today a deliberate omission — moods are the app's own, richer take).
- Designer memory: feed a few saved moods back through `state` as style examples, so
  the designer learns the house's taste instead of starting cold each time.
- Per-light accents inside a room as a clearly-scoped v2 surface — v1 composes at
  room level only, and grouped_light stays the write path for everything else.
- Time-of-day moods (dusk arriving on its own at sunset) — needs host-side
  scheduling, so it waits on a Snug scheduling primitive and its own ADR.
- Multi-bridge homes, once connection resolution can scope a request to one of
  several approved addresses; today the ambiguous-connection state deliberately
  refuses to guess.
- Entertainment areas / gradient strips as a separate surface, if ever — firmly
  outside the mood thesis today.
