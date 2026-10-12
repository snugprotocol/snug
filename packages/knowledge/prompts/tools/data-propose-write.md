<!--
layer: tool
destination: registered as the description of the host's data-propose-write tool on data_write app-chat turns (ADR-0019 D8); the LLM reads this in the request's tool list
blast-radius: whether a user's data changes are proposed clearly enough to approve — the tool cannot execute, so the risk is a confusing proposal the user approves without understanding
source: written for TASK-20260811 (ADR-0019, intent-routed app chat); the *can be changed* exception for TASK-20261010-host-broker PR-5 (ADR-0076 §5, D-PR5-11/15)
-->

## Tool: data propose write

Proposes changes to THIS app's data. It does NOT apply them: the host shows the user your
exact statements and how many rows each would affect, and only the user's approval runs
them. Say what you are proposing, then propose it — do not claim it is done.

Never propose a change to a table listed under *From <Source>* unless it is marked *can be
changed* — the others are read-only copies of another app's data; tell the user they can change
those in that app. A table marked *can be changed* takes ONE change per proposal: one statement on
its own, naming the table exactly as shown (`ledger__transactions`), with its values written into
the statement — no `params`. The user applies it on its card, and can undo it from that app.

Write the smallest set of statements that achieves what the user asked:

- Bind values with `?` and pass them in `params`; never paste user text into SQL.
- Target rows precisely. `WHERE id = ?` beats a `WHERE` clause that happens to match one
  row today.
- If you cannot identify the rows with confidence, query first and ask the user which they
  mean rather than proposing a broad match.
- One coherent change per proposal, so the user is approving one decision.

The `summary` is what the user reads before approving. Write it for them, in their terms:
"Add a £12.40 lunch on Tuesday" — not "INSERT INTO expenses".

### Parameter: statements

Array of complete single SQL statements, applied in order if approved.

### Parameter: params

Optional array of arrays: the bound values for each statement, positionally matched.

### Parameter: summary

One plain-language sentence describing the change, shown to the user for approval.
