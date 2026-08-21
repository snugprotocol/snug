# Vision

Every chess app embeds an engine. ember chess deliberately ships none — the oldest
sentence in the Snug README is a chess sentence: the app is a *body*, the agent is the
*mind*. This starter exists to make that sentence playable within a minute of opening
the hub.

Three ideas carry it. **Refereeing**: the model is a player, never a judge — a compact
in-app move generator decides what is legal, so no confabulated move can corrupt the
board; the worst an off-script reply can do is forfeit its choice to a random legal
move, announced honestly in the banter. **Conversation**: every turn is one JSON
exchange — position, capped history, and the agent's complete legal move list out; a
chosen move and a line of table talk back — the cleanest demonstration of a
schema-shaped agent turn on the shelf. **Character**: the same app is three different
opponents, because personality is a payload field, not a fork of the code.

The emotional core is the table talk. Chess against a machine is silent; chess against
ember is company — a gracious rival tipping its king, a hustler crowing over a fork, a
coach explaining the idea behind its move. You are not playing an engine's evaluation;
you are playing someone, and the board between you never lies.
