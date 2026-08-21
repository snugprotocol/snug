# Lessons

**The model is a player, never a judge.** Even handed its complete legal move list,
the agent can still answer with an illegal move — or with prose that is not JSON at
all. Validating every reply against the app's own list, and playing a random legal
move with an honest note when it misses, keeps one bad turn from corrupting every
turn after it.

**Send the situation, not the transcript.** The original request carried the FEN in
both payload and state, an unbounded state history, and a persona paragraph on every
move — invisible in the UI, paid for on every turn. ADR-0018 moved the FEN to `state`
only, capped history at 12 plies, and parked the persona prose in the runtime
contract; `validate.test.mjs` pins the fix ("sends its board state ONCE") so the
over-send cannot quietly return.

**A small referee is safe when it defines the game.** Dropping castling and en
passant would be a bug in an engine that must agree with the outside world — here the
agent only ever chooses from the list the app supplies, so referee and opponent can
never disagree about what is legal. Simplification is fine as long as it is declared:
the cut is written into the README and the source comment.

**Errors are data.** A failed agent request becomes banter content — "the agent went
quiet (…) poke it to retry" — with a retry button, never a crash or a frozen board.
The failure path lives in the same bubble as the character, so even breaking down
stays in voice.

**Personality is data, not code.** Three opponents are one array of
`{id, emoji, label, prompt}` objects plus a payload field; the contract's
`personaNote` tells the model to voice whichever persona the request names. Adding a
fourth character is adding an object, not forking the app.
