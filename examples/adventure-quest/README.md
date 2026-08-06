# adventure quest

A tiny valley quest: find the Sun Key, open the door on Dragon Peak. Both product
pillars in one app — the **agent is the dungeon master**, and the **world lives in the
user's own SQLite file**.

## What it demos

- **Agent-as-brain, app-as-referee**: every leg sends the scene, the chosen action, the
  hero stats and the pack with a `responseSchema` of `{narration, hpDelta?, goldDelta?,
  message?}`. The agent narrates; the **app** decides destinations and loot from its own
  scene graph, and clamps the agent's deltas hard (hearts −3..3, gold −5..8, hearts never
  below 1 — kid-safe by construction).
- **Own-your-data**: the pack (`aq_inventory`) and travel journal (`aq_journal`) are real
  SQLite tables written through `useAppDB` — the host's **export .sqlite** button
  downloads the whole adventure.
- **Graceful no-LLM stance (ADR-0011)**: an off-schema or failed reply (the demo brain's
  canned answer is exactly that) hands the leg to a local narrator with a visible note —
  the quest never stalls on a missing key. Same pattern as chess's "off-script" fallback.
- **Kid-first**: emoji scenes, big choice buttons, two-tap "start over", both themes.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
