*Reconstructed retrospectively (2026-08-21, TASK-20260821-hardening-polish): no verbatim prompt provenance exists for this starter — this page describes the build brief its code implies, so app-attached chat has honest context.*

# Build prompt — Adventure Quest

- **Date of the build it reconstructs:** 2026-08-06 (TASK-20260806-starters-pillars,
  one of the five pillar starters)
- **Model:** Claude Fable 5, via Claude Code (from the build commit's trailer)
- **Supersedes:** nothing — first prompt of this app

The brief the code implies:

---

Build a tiny text adventure that shows both product pillars in one app — the agent as
the brain, the data as the user's own. Make it kid-first: emoji scenes, big friendly
choice buttons, warm storybook narration, and honour both themes.

Give it a complete quest a child can actually finish: a Sun Key hidden somewhere in a
small valley, and a sealed door on a dragon's peak that only the key opens. The map
should be a handful of hand-drawn scenes with clear choices between them.

The agent is the dungeon master: on every move, send it where the player came from,
where they are going, whether the way was blocked and why, the hero's hearts and
gold, and what is in the pack, with a response schema asking for a short narration
plus optional heart and gold changes and a line of table talk. But the app is the
referee — it alone decides destinations, loot and the locked door from its own scene
graph, and it clamps whatever deltas the model proposes so hearts can never fall
below one. A bad reply must never be able to hurt a kid's game.

Store the pack and a travel journal as real SQLite tables through the app database,
so the host's export button carries the whole adventure away in the user's own file.
If no model is configured, or a reply comes back off-schema, a local guide should
narrate the same leg with a visible note — the quest must never stall. Include a
two-tap "start over" that wipes the tables and begins fresh.

Ship it as a single `app.html` on the standard embedded hook block, with no network
access at all.
