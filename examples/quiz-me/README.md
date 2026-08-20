# quiz me

The education wow: pick any topic and the agent writes a five-question quiz; the app
runs it and keeps every score in a real SQLite table.

## What it demos

- **The agent as question-writer, the app as referee**: `make_quiz` sends the topic with
  a `responseSchema` demanding exactly 5 × `{question, choices[4], answerIndex, funFact}`.
  The reply is validated hard (shape, four choices, index in range) — anything less is
  rejected wholesale, never partially trusted.
- **Graceful no-LLM stance (ADR-0011)**: a failed or off-schema reply (the demo brain's
  canned answer is exactly that) swaps in the built-in practice bank — four topics plus a
  mixed round for unknown ones — with a visible "question robot is offline" note. A
  keyless first visit still gets a complete quiz.
- **Scores in YOUR file**: results land in `quiz_scores` via `useAppDB` and render as a
  little history chart; the host's **export .snug** button takes the whole record home.
- **Kid-first**: topic chips, one question at a time, instant feedback with a fun fact,
  encouraging results copy, both themes.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
