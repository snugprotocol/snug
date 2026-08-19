# spotify — "Rewind": your listening, understood

**What it demos:** the full OAuth-connected story on a beloved consumer API — a
listening portrait computed from the user's own Spotify data (top tracks/artists across
three time ranges, rotation depth, discovery ratio), an app-owned SQLite journal that
accumulates the trend-over-time view Spotify's API cannot return, governed playback
control where every write stops at the host's confirm, and a chat-teaching surface that
shows how the app's chat lane rides the same connection. All "art" is CSS: gradient
tiles from string-hashed hues, no images.

**Complement thesis:** Spotify's own app shows you music; Rewind understands *your
listening* and remembers what Spotify forgets. Nothing here re-implements browsing or
playback UI for its own sake — the portrait, the journal, and the agent's weekly rewind
are things Spotify's app does not do, and the one overlapping surface (Now) exists to
demonstrate governed writes, not to replace the real player.

**Connection posture:** slot `spotify`, kind `oauth2_auth_code` with PKCE (Client ID
only — no client secret ever). Fields, walkthrough, and scopes arrive registry-pinned
at install review (ADR-0028): the 7 read+playback scopes
(`playlist-read-private`, `playlist-read-collaborative`, `user-read-private`,
`user-library-read`, `user-top-read`, `user-read-playback-state`,
`user-modify-playback-state`). Works on web and desktop (desktop uses the registry's
fixed-port loopback redirect posture). Note the pin deliberately omits
`user-read-recently-played`: the app attempts that read once per session, treats the
403 as a labeled degrade, and derives discovery from top-list drift instead — see
[`authoring/docs/plan.md`](authoring/docs/plan.md).

## Sample mode

Before Spotify is connected, the Portrait surface renders a fully fictional sample
listener — authored constants (invented artists, never real ones) drawn through the
same tiles, meters, and magazine card the live portrait uses, under a visible
"sample data" banner. The dataset plants the app's story across all three lenses: a
one-album obsession month (rotation depth 62%), the six-month discovery season it
grew out of, an artist who climbed from a spring discovery into the all-time top
five, and one canned weekly-rewind column showing what the agent writes from real
numbers. It is deterministic and render-only (no clock, no PRNG, no bridge/db/net
calls), a journaled real portrait always outranks it, and the first successful
Spotify read unmounts it wholesale — nothing sample survives into a connected
session.

**LLM posture:** agent-driven (ADR-0011) — `RESPONSE_SCHEMA` is non-null, every
`sendMessage` carries a `responseSchema` plus full compact stats in `state`, and the
runtime contract ships in [`runtime-contract.json`](runtime-contract.json). The agent
writes exactly one artifact: the magazine-style weekly rewind card, validated hard;
off-schema replies become a visible notice with a retry, never rendered content.
Keyless/demo hosts still get a working app: the portrait renders from live data or the
journal, and only the rewind card degrades.
