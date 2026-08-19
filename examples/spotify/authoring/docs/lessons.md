# Lessons

**Scope honesty beats silent degradation.** The registry pin carries top-lists and
playback but not `user-read-recently-played`. Rewind attempts that read once per
session, expects the 403, says so in the discovery caption, and derives the metric
from top-list drift instead. The feature degrades loudly with its reason attached —
and lights up with no code change if a future pin ever grants the scope.

**Journal what the API forgets.** Spotify's API only answers about the present; the
entire Trends surface exists because one compact snapshot per day (latest visit wins)
accumulates the history the API cannot return. Defining rotation depth and discovery
once and journaling them with the same meaning is what keeps day-over-day bars honest.

**Complement, never clone.** No browse, no search, no library. The one overlapping
surface (Now) exists to demonstrate governed writes — every control stops at the
host's confirm — not to replace the player. That restraint is what keeps the thesis
("your listening, understood") legible.

**Validate the agent's artifact hard, then trust it fully.** The weekly rewind card is
accepted only when headline, story, and highlights all check out — typed, trimmed,
length-capped. Off-schema replies become a visible notice with a retry, never rendered
content. That hard edge is exactly why the accepted card can be trusted as magazine copy.

**A labelled sample beats an honest skeleton.** The first ship deliberately refused
sample data ("no sample data pretends to be you") and showed a shape-only skeleton — it
sold nothing. A fictional listener with planted contrasts (an obsession month at 62%
rotation, the discovery season it grew out of, a climber cracking the all-time five)
rendered through the real components under a sample banner keeps the honesty while
finally showing what the app is for. The journal fallback still outranks it, and the
first real read unmounts it wholesale.

**Data-driven CSS art keeps the file self-contained.** Gradient tiles hashed from
track/artist identity mean no images, no external asset hosts, and no CSP exceptions.
Content styling stays out of the theme tokens, so dark mode never fights the art.
