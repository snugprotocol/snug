# Plan

Built as one of the five pillar starters (TASK-20260806-starters-pillars), in four
layers inside a single `app.html`:

1. **The schema and the referee** — `RESPONSE_SCHEMA` spells the demanded shape in
   prose (exactly 5 × `{question, choices[4], answerIndex, funFact}` plus an intro
   `message`); `validateQuiz` enforces it in code: object shape, non-empty question,
   exactly four non-empty choices, no duplicates (case-insensitive), integer
   `answerIndex` in 0–3, trimmed output capped at five. One `null` fails the lot.
2. **The practice bank** — `BANK`: four authored shelves (space, animals, earth,
   numbers) of five questions each; `bankFor` matches a known topic exactly and
   otherwise deals a mixed round, so no typed topic ever dead-ends.
3. **The quiz machine** — three phases (`topics` → `quiz` → `results`) in plain
   React state. `startQuiz` sends `make_quiz` with the topic, count and audience,
   `responseSchema` attached; a valid reply seats the agent quiz with its intro
   line, anything else seats the bank with the offline note. `pick` locks the
   answer and shows feedback plus fun fact; `next` advances or finishes.
4. **The record** — `quiz_scores` DDL run behind the host-ready gate via
   `useAppDB`; a `savedRef` guard writes the score exactly ONCE when the round
   ends; `loadHistory` SELECTs the last eight rounds into the history bar card.

Test spine: the examples validate suite (LLM-posture lint — `sendMessage` with a
`responseSchema` in the authored region; `runtime-contract.json` parsed through the
real schema; hook byte-sync, no-network and literal-SQL rules); the playground
`starterShelf.test.tsx` keeper roster; `e2e/starters.spec.ts` — the Enter-path
journey through the fallback bank, plus the zero-trace export guard and the
install-after-browsing persistence test, both riding a full `completeQuiz` round as
the cheapest provable starter-namespace SQL write.
