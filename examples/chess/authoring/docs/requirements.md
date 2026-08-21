# Requirements

Owner requirements, restated as musts (reconstructed from the shipped code — see
prompts/01-build.md for provenance):

1. Must play a complete game: the user as white, the agent as black — standard moves,
   captures, check, checkmate and stalemate, with automatic promotion to queen.
2. Must make the app the referee. Legality is decided by the app's own move generator;
   the model is never trusted on the rules.
3. Must send the agent everything it needs as one JSON turn: the position as FEN, the
   recent history, and — crucially — its complete legal move list, with a declared
   `responseSchema` for the reply.
4. Must survive a bad reply. An illegal move, malformed JSON, or a raw-text answer
   plays a random legal move on the agent's behalf with an honest note in the banter
   bubble; an errored request surfaces a "poke the agent" retry instead of stalling.
5. Must give the opponent a switchable personality — gracious rival, trash talker,
   patient coach — that shapes its table talk, not its strength: one app, three
   characters, selected by an id in the payload.
6. Must keep requests lean (ADR-0018): the FEN lives in `state` only, history is
   capped at the last 12 plies, and the persona prose is stored once in the runtime
   contract rather than re-sent with every move.
7. Must resume mid-match: FEN, history, banter and the chosen persona persist through
   the host's key-value store, so a reload restores the game exactly.
8. Must ship its runtime contract (`runtime-contract.json`) so any adapter — including
   a user's own key — plays the opponent consistently.
9. Must stay a single file on the fixed CDN allowlist, its hook block byte-identical
   to `packages/sdk/embedded/snug-hooks.js`.

Hard boundaries: no chess engine and no evaluation in the app — the opponent's strength
is the model's own; no castling and no en passant, a deliberate cut that keeps the demo
referee compact; the hook block is contract code and is never edited.
