# trivia night

Pass-and-play trivia for 2–4 players on ONE device — the multiplayer *feeling* with
zero networking, zero accounts, zero setup.

## What it demos

- **LLM-free by declaration (ADR-0011)**: `RESPONSE_SCHEMA = null` and the authored code
  never calls `sendMessage` — enforced by the validate suite's posture check. Questions
  come from a built-in deck; scoring is arithmetic; the "network" is the device moving
  between hands.
- **Pass-and-play as a design pattern**: a no-peeking interstitial ("pass the device to
  Maya!") between every turn is what turns a single iframe into a party game.
- **Persistence picked per write-pattern**: the player roster is a real SQLite table
  (`tn_players` via `useAppDB`) because a key-value write racing the initial hydration
  can be silently overwritten when the stored value lands — SQL inserts have no such
  race, and the roster rides along in the exported `.sqlite`. The hall-of-fame best
  score stays in `usePersistedState`: it is only written at podium time, long after
  hydration settles.
- **Kid-first**: auto-assigned animal emoji per player, big answer buttons, a podium with
  a crown, two-tap player removal, both themes.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
