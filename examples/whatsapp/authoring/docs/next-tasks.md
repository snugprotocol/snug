# Next tasks

- Voice notes and documents as first-class message kinds (text and photos ship; other
  media currently render as a bare placeholder). Same transport cap discipline as photos:
  refuse over-cap, never truncate.
- Search across the local message cache — the `messages` table already holds everything a
  find-in-chat needs, and nothing about search has to leave the machine.
- An analysis timeline: the `analyses` table keeps every run pseudonymised, but the UI only
  surfaces the latest. Show what changed run-over-run — the delta headline is already
  written for exactly this.
- A response graph for groups (who answers whom): `responseStats` is per-author today; a
  pair-wise version needs a group-sized hostile fixture before it ships.
- Surface the send journal (`activity` table) in the UI — the record exists, the user has
  no window onto it.
- Auto-reply stays out. The platform's standing-approval gate (ADR-0033) exists, unarmed;
  arming it for Telepath would need its own ADR and an explicit owner ask, not a task here.
