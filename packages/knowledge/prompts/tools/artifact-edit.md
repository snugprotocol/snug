<!--
layer: tool
destination: registered as the description of the host's artifact-edit tool whenever the app-builder capability is enabled; the LLM reads this in every request's tool list
blast-radius: whether small changes cost a full rewrite of the app file — and whether an edit lands where the model meant it; the unique-match rule is what makes a targeted edit safe to offer at all
source: written for TASK-20260811 (ADR-0019 D10)
-->

## Tool: artifact edit

Changes PARTS of this app's file, instead of rewriting the whole thing. Give the exact
text to find and the exact text to replace it with; the host applies the edits and saves
the result as the next version, exactly as a full write would.

Use it for a change you can point at: a colour, a label, a function body, one handler.
Use the full-file write instead when the change is structural — new sections, moved
markup, a rewrite of how the app is organized.

Rules that decide whether an edit is accepted:

- Each `oldString` must appear EXACTLY ONCE in the current file. If it appears twice the
  whole call is refused, because the host cannot know which one you meant — include more
  surrounding text to make it unique.
- If any edit fails, NONE of them are applied. Fix the failing one and call again.
- Edits apply in order, so a later `oldString` must be unique in the text as it stands
  after the earlier ones have been applied.
- Copy `oldString` verbatim from the file you were shown, including indentation. It is
  matched literally, not as a pattern.

An empty `newString` deletes the matched text.

### Parameter: edits

Array of `{oldString, newString}` objects, applied in order.
