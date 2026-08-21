# Next tasks

- Reconcile `runtime-contract.json` with the app's own schema: the contract's
  `responseGuidance` describes `{q, choices, answer}` while the referee validates
  `{question, choices, answerIndex, funFact}` — the per-request `responseSchema`
  wins today, but the two documents should agree.
- A "revise what you missed" round: the app forgets WHICH questions were wrong the
  moment the round ends — only the score survives; keeping the misses would enable
  targeted replays.
- Quiz length and difficulty knobs: five questions and the 11-year-old audience are
  hard-coded in `startQuiz`, the schema and the validator together.
- Richer history: the card shows the last eight rounds as bars; per-topic bests and
  an over-time trend are one SELECT away from the same table.
- Grow the practice bank (four shelves of five) or at least label the mixed round
  as mixed, so an unknown-topic fallback doesn't present itself as on-topic.
- Stream the intro line: the hooks support `onStream`, but the app waits for the
  terminal reply — a kid stares at "writing your quiz…" longer than needed.
