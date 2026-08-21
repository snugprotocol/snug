# Requirements

Owner requirements, restated as musts (reconstructed from the shipped app and the
TASK-20260806-starters-pillars history):

1. Must turn ANY typed topic into a five-question multiple-choice quiz written by
   the agent — four preset topic chips plus a free-topic box, Enter included as a
   first-class submit path.
2. Must demand a strict reply shape from the agent: exactly 5 ×
   `{question, choices[4], answerIndex, funFact}` via a `responseSchema` on every
   `make_quiz` request, plus one encouraging intro line.
3. Must referee that reply without partial trust: wrong shape, a missing choice, a
   duplicate choice, or an out-of-range answer index rejects the WHOLE quiz —
   never a mixed round of agent and fallback questions.
4. Must be fully playable with no LLM configured (ADR-0011): a failed or
   off-schema reply swaps in the built-in practice bank — four authored topics
   plus a mixed round for unknown ones — behind a visible "question robot is
   offline" note, never silently.
5. Must keep every score in the user's own file: a `quiz_scores` SQLite table,
   written exactly once per finished round, rendered as a history bar chart.
6. Must be kid-first: one question at a time, instant right/wrong feedback with a
   fun fact, stars and encouraging copy at the results screen, both themes.
7. Must ship a runtime contract (ADR-0018) declaring its agent-driven posture and
   an 11-year-old-reader persona for the question-writer.

Hard boundaries: single-file app over the byte-synced embedded hooks; no network
of its own (the sandbox has none); no browser storage (host-brokered only); a
browsed-but-uninstalled copy leaves zero trace in the exported user file.
