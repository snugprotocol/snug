<!--
layer: tool
destination: registered as the description of the host's data_propose_write tool on a scheduled *Ask <App>'s AI* step that may look things up (agent/dataTools.ts, the `scheduled` seat; ADR-0076 §9, D-PR4-16) — the chat's data_write turns keep tools/data-propose-write.md, byte for byte; the LLM reads this in the request's tool list
blast-radius: what an unattended agent offers to change in the user's own data — under a schedule the user let make changes on its own, a change this tool admits may be made by the host when the run finishes (this app's own data only, within the schedule's rows-each-time limit, undoable for seven days); weak wording produces changes that are refused, that wait for the user needlessly, or that the result misdescribes — never a change to another app's data (the host refuses it) and never one made while the agent works
source: written for TASK-20261010-host-broker PR-4 Gate 5 (JOBS-F2 — the scheduled variant gets its own definition; the chat's says only the user's approval runs a change, which is false under such a schedule)
-->

## Tool: data propose write

Proposes ONE change to THIS app's own data, for the result of this scheduled run. Nothing is
changed while you work: the host tries the change on a copy of the data, and its answer tells
you what happens next — it waits for the user's OK on the result, or this schedule may make it
on its own when the run finishes, within its limits, and the user can undo it.

Never say a change was made — say what you proposed; the host reports what it made.

Never propose a change to a table listed under *From <Source>* — those are read-only copies of
another app's data.

Write each change so the host can make it on its own and undo it:

- ONE INSERT, UPDATE or DELETE statement per call — propose each change on its own.
- Every value written into the statement itself, as a literal: `'Tuesday'`, `12.4`. A scheduled
  change has nothing to bind a `?` or a named placeholder to, so a statement carrying one is
  refused.
- A `WHERE` on every UPDATE and DELETE that names the rows precisely — `WHERE id = 7`, not a
  clause that happens to match one row today. Query first when you are not sure which rows.
- No functions, arithmetic or conflict clause. A change that needs one still waits for the
  user's OK; a nested SELECT is refused outright.

A run holds at most 3 changes, so propose the ones that matter. When the answer says a change
was refused, fix what it names or leave it out — do not send the same statement again.

The `summary` is what the user reads on the result. Write it for them, in their terms:
"Mark the fern as watered today" — not "UPDATE plants".

### Parameter: statements

An array holding exactly ONE complete INSERT, UPDATE or DELETE statement, its values written
in — at most 2,048 characters.

### Parameter: summary

One plain-language sentence describing the change, shown to the user on the result.
