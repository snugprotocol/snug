# build prompt — 2026-08-15, authored by Claude (Fable 5) for TASK-20260815-starter-apps-rebuild

# spotify — "Rewind": your listening, understood

Build examples/spotify/app.html — a single-file Snug starter for the owner-quality shelf. Complement Spotify's own app, never clone it: Spotify shows you music; Rewind understands YOUR listening and remembers what Spotify forgets.

Surfaces (desktop-first, stacks at 375px):
1. **Portrait** (default): a beautiful listening portrait composed from /v1/me/top/tracks and /v1/me/top/artists (time_range=short_term|medium_term|long_term as a segmented control) + /v1/me/player/recently-played — rotation depth (how concentrated your plays are), discovery ratio (new artists in recent plays vs repeats), top-5 tracks/artists rendered with CSS-drawn art (no images — gradient tiles from string-hashed hues), one accent color.
2. **Trends**: every visit journals a compact snapshot (top artist/track ids + counts) into the app DB via useAppDB — the trend-over-time view Spotify's API cannot give you historically. CSS bar/spark visuals.
3. **Now**: current playback (/v1/me/player) with elegant play/pause/skip (PUT/POST /v1/me/player/... — these are governed writes: the host shows a confirm; design copy accordingly).
4. **Ask**: a chat-teaching panel — sample prompts the user can copy into the app chat ("which song did I play most last week?", "make me a set from my heavy-rotation artists") explaining the host routes these through the Spotify connection.

Agent turns (RESPONSE_SCHEMA + sendMessage): a "weekly rewind" — the app fetches the data, sends compact stats in state, the agent replies {headline, story, highlights[]} rendered as a magazine-style card. Validate hard; off-schema → graceful visible fallback. Keyless/demo → the portrait still renders from any journaled data or an honest empty state.

Un-connected state: honest, beautiful — explain what connects, show a skeleton preview, no fake data presented as real.
