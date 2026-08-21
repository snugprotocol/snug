# Lessons

**Duplicate choices are a correctness bug, not a style problem.** The adversarial
review round caught it: two identical choices either make the "right" answer
ambiguous or leak it by elimination. The fix was one `Set` size check in
`validateQuiz` — and because the referee only rejects wholesale, one bad question
retires the whole agent quiz rather than shipping a broken round.

**The fallback IS the demo.** The demo brain's canned answer is off-schema by
design, which routes every keyless visit straight through the practice bank — the
exact path a real model failure takes. That makes the graceful-degradation story
testable: the e2e journey pins the "question robot is offline" note and the bank
round deterministically, with no model in the loop.

**Enter is part of the contract.** The free-topic box originally submitted only via
the button; the review round added the `Enter` keydown path and the e2e now drives
it. A text input a kid can't submit from the keyboard is a fixture, not a form.

**Write the score once, at the finish line.** The INSERT lives behind a `savedRef`
guard and fires only at "see my score" — replaying the last question can never
double-count. A side effect: a full round became the cheapest interaction that
provably writes SQL in the starter's namespace, so the export-bytes zero-trace
guard and the install-persistence test both reuse `completeQuiz` wholesale.

**Trust nothing partially.** The referee never salvages the good questions from a
half-valid reply. All-or-nothing sounds wasteful, but the alternative — a quiz that
is three agent questions and two bank questions, unlabelled — quietly lies to the
user about where their quiz came from.
