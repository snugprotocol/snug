<!--
layer: tool
destination: registered as the description of the host's runtime-contract-write tool with the agent adapter whenever the app-builder capability is enabled; the LLM reads this in every request's tool list
blast-radius: whether an app's OWN runtime turns are cheap and well-framed — a missing or vague contract means every later turn falls back to generic layers, and a wrong one misdescribes the app to itself on every move
source: written for TASK-20260811 (ADR-0018, lean runtime turns)
-->

## Tool: runtime contract write

Records how THIS app should talk to the model at RUN time — after it is built, every time
a user takes an action in it. The host stores this with the app's version and sends it
INSTEAD of the app-building instructions you are reading now. A Chess app's move request
does not need to know how to write HTML; it needs to know it is a chess opponent and what
shape of answer to give back.

Call it whenever you write an app that talks to the agent (its code calls `sendMessage`),
right after the artifact write — and again on any later change that alters what the app
sends, what it expects back, or how it should behave. A cosmetic change needs no new
contract; the stored one carries forward automatically.

Write it from the app you just built, not from the conversation: the user's phrasing,
your reasoning, and the build steps are all irrelevant at run time. Keep every field
short — this text is sent on EVERY turn the app takes, including on small local models.

### Parameter: overview

Required. What the app is and what the model's job is inside it, in a sentence or two.
"A chess app. You play as the opponent and reply with one legal move." Do not describe
the UI or how the app was built.

### Parameter: personaNote

Optional. Voice or difficulty guidance the app's answers should follow — "play at club
strength; never explain the move unless asked".

### Parameter: stateGuidance

Optional. What arrives in each request, so the model knows what it can rely on: "each
request sends the current board as FEN plus the last move — not the game history".

### Parameter: responseGuidance

Optional. The minimal JSON shape expected back, as a concrete example:
`{"move":"e2e4","message":"..."}`. Ask for the fewest fields the app actually reads.

### Parameter: settings

Optional. The app's own settings that change the model's answers, as flat key/value pairs
— `{"difficulty":"hard"}`. Not the whole settings object: only what shapes a reply.

### Parameter: maxOutputTokens

Optional. A ceiling for replies from this app, when its answers are naturally short (a
move, a score, a single suggestion). Leave it out when replies can legitimately be long —
a story or an explanation — because the cap truncates rather than summarizes.
