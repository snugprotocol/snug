<!--
layer: knowledge-base
destination: app-authoring KB section, retrieved via searchKnowledge during a build; teaches lean runtime requests and runtime-contract emission (ADR-0018)
blast-radius: how much every INSTALLED app spends on every turn it takes, and whether its run-time answers are well framed — apps built without this over-send state and run on generic instructions forever
source: written for TASK-20260811 (ADR-0018, lean runtime turns)
-->

## Runtime requests: what an app sends when it asks the model

An installed app's request to the model is a **self-contained envelope**. There is no
conversation behind it — no build chat, no earlier turns, no memory of the last move. What
you put in the request is all the model gets, and it is sent again on every single action
the user takes.

So send the CURRENT SITUATION, not the history:

- Send the state needed to answer THIS request: the current board, this month's rows, the
  item being edited. Not the whole game log, not every row in the table.
- Put it in ONE place. `state` is for the app's situation; `payload` is for what the user
  just did. Sending the same board in both `payload` and `state` doubles the cost of every
  turn and tells the model nothing extra — a common and expensive mistake.
- Keep `responseSchema` to the fields the app actually reads. Every field you ask for is a
  field the model spends tokens producing.
- Do not re-send persona or difficulty prose on each request. That belongs in the app's
  runtime contract, below, where it is stored once.

## The runtime contract: how your app talks to the model after it is built

When your app calls `sendMessage`, call `{{runtimeContractWriteToolName}}` after writing
the artifact. It records — once — what the app is and what a good answer looks like, and
the host sends that with every run-time request INSTEAD of these app-building
instructions. A chess move does not need to know how to write HTML.

Write it from the app you just built:

- `overview` (required, up to 600 characters) — what the app is and the model's job in it:
  "A chess app. You play as the opponent and reply with one legal move."
- `personaNote` — voice or difficulty, if the app has one.
- `stateGuidance` — what each request carries: "each request sends the current FEN and the
  last move, never the full history".
- `responseGuidance` — the minimal reply shape, as a concrete example built from the
  fields your app reads: `{"move":"e2e4","message":"..."}`.
- `settings` — flat key/value pairs of app settings that change answers, such as
  `{"difficulty":"hard"}`.
- `maxOutputTokens` — between 256 and 8192, and only when replies are naturally short (a
  move, a score, one suggestion). Leave it out when a reply can legitimately run long,
  because the cap truncates rather than summarizes.

For a CONNECTED app, name the connection in the `overview` or `stateGuidance` by its slot
("the app's `spotify` connection carries the user's listening history") — the host's
provider chat lane routes user questions about that service, and a contract that names
the slot grounds those turns in what the app is actually connected to.

### When to write it again

Re-emit the contract on any edit that changes what the app sends, what it expects back, or
how it should behave — a new action, a changed response shape, a new difficulty setting.

A cosmetic edit needs no new contract: the stored one carries forward to the new version
automatically. Writing one anyway is not harmful, but leaving it alone is correct.

An app that never calls `sendMessage` needs no contract at all.

## Changing an app: edit the parts, or rewrite the file

Two tools change an installed app, and the choice is about the SHAPE of the change:

- **A change you can point at** — a colour, a label, one handler, a function body — is an
  edit. Give the exact text to find and what to replace it with. Cheaper, faster, and it
  cannot disturb the parts you did not name.
- **A structural change** — new sections, moved markup, a different organization — is a
  whole-file write. Trying to express a restructure as a dozen edits is how an app ends up
  half-migrated.

Each piece of text you ask to replace must appear EXACTLY ONCE in the file. If it appears
twice the whole edit is refused rather than guessing, so include enough surrounding text to
make it unique. If any edit in a batch fails, none of them are applied.
