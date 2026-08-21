# Next tasks

- Align the shelf copy with the shipped game: the hub blurb and the v1 changelog say
  "tap to keep the pig airborne", but the game is a slingshot — the copy describes a
  different pig.
- Pause handling: the loop runs on wall-clock time (`Date.now`), so a backgrounded
  tab comes back to escaped pigs and spent lives — a visibility pause would make it
  fair.
- Persist the music toggle (`musicOn` is plain state today; the high score already
  shows the pattern).
- A local leaderboard: only the single best score survives — a top-ten with dates via
  the SQL lane (`useAppDB` ships in the hook block, unused).
- Fly the projectile along the dotted aim arc it already draws — today the food
  simply appears at the release point.
- Keyboard aim-and-fire: the game is pointer-only.
- Honor `prefers-reduced-motion` for the perpetual bounce, rainbow and float
  animations.
