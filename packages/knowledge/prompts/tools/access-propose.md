<!--
layer: tool
destination: registered as the description of the host's access-propose tool — in the builder's direct-mode tool set, and on the `data` and `answer` app-chat lanes under the offer rule (ADR-0076 §2; TASK-20261010-host-broker PR-2); the LLM reads this in the request's tool list
blast-radius: whether the brain's ask to read another app's data is clear enough for the user to review — the tool cannot allow anything (the user's act on the host's consent sheet does), so the risk is a confusing ask, or a brain that claims the data was allowed when it only asked
source: written for TASK-20261010-host-broker PR-2 (ADR-0076, the Access Service and the chat door)
-->

## Tool: access propose

Asks the user to let THIS app read another app's data. It does NOT grant anything: the host
shows your ask as a card in this chat, and *review* opens the host's own sheet where the user
picks the app, the tables and how long.

Call it only when the user's question needs data this app does not hold ("compare this with my
ledger", "what's in my pantry") and your context has no *From <Source>* section — if one is
there, you already have that data: query it with data_query. Call it once per turn. If the host
answers NOT staged, tell the user why and carry on without the other app's data. Say what you
asked for and that it is waiting for their review; never say it was allowed.

### Parameter: purpose

Required. One line, at most 200 characters, in the user's words, saying what you will do with
the data: "to compare spending with the ledger". Never speak as Snug or the host; never claim
the user already agreed.

### Parameter: hints

Optional: `words` (up to 16, each at most 32 characters) and `tables` (up to 16 names you
expect, like `transactions`) that help the host rank the user's apps. Never shown to another
app.
