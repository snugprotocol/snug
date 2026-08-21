# Lessons

**LLM-free is a declared posture, not an omission.** The origin game played against the
AI; this one deliberately does not — `RESPONSE_SCHEMA = null` plus authored code that
never calls `sendMessage`, and the validate suite's posture lint holds the app to both.
The agent's role ended when it authored the app, and saying so in code is what makes
the exemplar enforceable rather than accidental.

**The handshake is the contract; the agent call is not.** First paint waits for
host-ready because the high score hydrates through the bridge — skip the gate and
every launch flashes "Best: 0" before the real number lands. Even an app that never
speaks to the model still boots through the protocol.

**Decide instantly, animate the story.** The hit is resolved the moment the player
releases — every live pig projected onto the aim ray against a viewport-scaled radius —
while the flying food plays half a second of theater on top. An arcade about reflexes
cannot make the outcome wait for a physics sim; the split keeps the feel honest AND
the code simple.

**The game director is a formula.** Pig speed follows measured accuracy and level,
clamped and displayed on the meter, so the player can see exactly why the pigs got
faster. Dynamic difficulty needs feedback, not a model.

**Perpetual motion fights the test harness.** The start button carries an infinite
bounce animation, so Playwright's stability check can never settle; the e2e journey
clicks it with `force: true` and says why in a comment. Charm animations are
load-bearing UI — tests must name them, not wait them out.
