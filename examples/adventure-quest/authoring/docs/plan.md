# Plan

Built as one of the five pillar starters (TASK-20260806-starters-pillars), in four
layers inside a single `app.html`:

1. **The scene graph** — seven hand-authored scenes (gates, market, forest, river,
   cave, hill, peak) as one plain object: local narration, arrival loot or gold,
   choice edges, and exactly one gate — the peak `needs` the Sun Key and carries its
   own blocked line. The graph is the referee's rulebook; the model never edits it.
2. **The state split** — hero scalars (`started`, `won`, `scene`, `hp`, `gold`) in
   host-brokered KV via `usePersistedState('aq-hero')`; the pack (`aq_inventory`) and
   journal (`aq_journal`) as SQLite tables behind a DDL gate that must succeed before
   the quest can begin; the journal view reads the six most recent entries.
3. **The dungeon-master lane** — a single `take_action` message per leg carrying
   from/to/action/blocked/hero/pack, with `RESPONSE_SCHEMA` `{narration, hpDelta?,
   goldDelta?, message?}`. The reply's deltas are clamped (hearts −3..3, gold −5..8,
   floor 1 heart), scripted arrival outcomes are added on top, and an errored or
   off-schema reply routes to the local narrator with a visible `dm-note`.
4. **The screens** — intro (pitch + begin, gated on DDL), quest (HUD, scene card with
   choices, pack, journal), and win; a two-tap armed reset clears both tables and
   restores the fresh hero.

Test spine: the examples validate suite's per-app rows (single-file, byte-identical
hooks, no browser storage, no forms, literal SQL, agent-driven ADR-0011 posture, and
`runtime-contract.json` parsing under the real schema); the playground `starterShelf`
keeper-folder row; and the Playwright `starters.spec.ts` journey — begin, choose, the
local guide's note under the demo brain, and browsing writing no app row.
