# ember chess

Play white; the agent plays black — with a switchable personality (gracious rival,
trash talker, patient coach) that shapes its table talk.

## What it demos

- **JSON-only agent conversation**: each player move sends the FEN, recent history, and —
  crucially — the agent's *complete legal move list*, with a `responseSchema` of
  `{move: {from, to}, message, gameOver?, winner?}`.
- **The app is the referee**: move legality is decided by a compact in-app move generator,
  never by the model. If the agent replies with an illegal move (or something that isn't
  JSON at all — e.g. the mock adapter), the app plays a random legal move on its behalf and
  says so in the banter bubble. If the reply errors, a "poke the agent" retry appears.
- **Personality as a payload field**: the persona prompt travels in the `player_move`
  payload — same app, three characters.
- **Resumable**: the FEN, history, and banter live in `usePersistedState`, so a reload
  restores the game mid-match.

## Engine scope (intentional)

Standard moves, captures, check/checkmate/stalemate detection, automatic promotion to
queen. **No castling, no en passant** — deliberately out of scope for a compact demo
referee (also noted in the source).

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
