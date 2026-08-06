# family trip planner (single-user v1)

The family aspiration: dream places, a packing list and a day-by-day plan — the whole
trip in a SQLite file the family owns. Single-user by design in v1 (multi-user is a
post-2.0 frontier item).

## What it demos

- **LLM-free by declaration (ADR-0011)**: `RESPONSE_SCHEMA = null`, no `sendMessage` in
  authored code (enforced by the validate suite's posture check). A trip plan is the
  family's own data; every operation on it is deterministic.
- **Three tables, three tabs**: `trip_places` (dream board), `trip_packing` (checklist
  with a packed-progress meter), `trip_days` (day 1–7 plans) — all through `useAppDB`,
  all included in the host's **export .sqlite** download. The ownership card up top
  points at that button, habit-tracker style.
- **Kid-first**: rotating place emoji, ≥44px tap targets, two-tap removal everywhere
  (no `window.confirm`), a "ready to go! 🚀" moment when everything is packed, both
  themes, usable at 375px.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
