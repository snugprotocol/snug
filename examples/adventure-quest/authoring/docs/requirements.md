# Requirements

Owner requirements, restated as musts (reconstructed from the shipped code and README —
see prompts/01-build.md for provenance):

1. Must be a complete, winnable micro-quest: find the Sun Key somewhere in the valley,
   open the sealed door on Dragon Peak — a whole arc in a handful of choices.
2. Must let the agent narrate every leg as the dungeon master: each move sends the
   scene left and entered, the chosen action, whether the way was blocked and why, the
   hero's hearts and gold, and the pack, with a response schema for the reply.
3. Must keep the app as the referee: destinations, arrival loot, gold finds and the
   Sun-Key gate are decided by the app's own scene graph, never by the model.
4. Must clamp the dungeon master's deltas hard — hearts −3..3, gold −5..8 per leg,
   hearts never below 1 — so the experience is kid-safe by construction.
5. Must persist the pack and travel journal as real SQLite tables (`aq_inventory`,
   `aq_journal`) through `useAppDB`, so the host's export carries the whole adventure.
6. Must stay fully playable with no LLM configured (ADR-0011): an errored or
   off-schema reply — the demo brain's canned answer is exactly that — hands the leg
   to a local narrator with a visible note, and the story still advances.
7. Must be kid-first: emoji scenes, big touch-friendly choice buttons, a two-tap armed
   "start over", and both themes honoured live.
8. Must ship a runtime contract (ADR-0018) telling the host's system assembly what the
   app is, how to speak, and what each request sends.
9. Must persist its authoring provenance into the installed app's wiki (ADR-0035) —
   fulfilled retrospectively by this bundle.

Hard boundaries: no network lane at all (no `connection.json`, `useConnectedFetch`
never called); no browser storage — the sandboxed iframe has a null origin, so hero
state rides host-brokered KV; scalars in KV, collections in SQL; no forms.
