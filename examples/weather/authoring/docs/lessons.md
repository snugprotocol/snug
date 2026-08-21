# Lessons

**Do slot math in the place's timezone, never the browser's.** Every time helper
shifts the epoch by the API's own `timezone` offset and reads UTC fields, so
"tomorrow morning in Reykjavík" means Reykjavík's morning whatever the viewer's
clock says. One `localShift` helper used everywhere keeps the rule from being
sometimes-true.

**One window, two different questions.** Laundry needs the WHOLE window dry, so
'dry' judges by the worst slot; a run can pick its moment, so 'active' judges by
the best. Same slots, same scorer, opposite reduce — the decision's kind chooses
which slot gets to speak.

**Sometimes rain is the good news.** The 'water' kind inverts the frame entirely:
it ignores the stored window and sums the next 24 h of rain — rain coming means
skip, because the sky waters the garden for you. A verdict engine has to know
which side of the question the weather is on.

**The app is the referee, not the agent.** `validateAdvice` accepts a reply only
if the whole shape checks out — verdict enum, required reason, length caps on the
optional fields; anything else (the keyless demo brain's canned answer is exactly
that) leaves the local verdict standing with a visible note. Deterministic first,
agent as upgrade, honesty in the seam.

**Stale beats blank, said out loud.** A failed refresh keeps the last good
forecast on screen and labels its age; 401, 429 and un-approved each get their
own plain-language copy. Wiping the sky because one request failed would punish
the user for the network.

**Journal rows carry their own context.** The `journal` table denormalizes title
and place as plain text, so the history survives deleting the card or the place
it came from — the record of what you decided must not depend on the things you
decided about still existing.
