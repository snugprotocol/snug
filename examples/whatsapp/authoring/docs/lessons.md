# Lessons

- **A green test you have never seen fail is not evidence.** All 18 analysis tests passed on
  their first run. Mutating the code found two that were measuring nothing: the JID scrub test
  used a JID as the *author*, so the pseudonym map replaced it by name and the JID regex was
  never reached (deleting the regex left the test green), and the "stable pseudonyms" test
  built the map twice from the same array, where insertion order is identical either way and
  an unsorted map passes. Both fixtures were rewritten to fail only on the guard they name —
  a JID in a message *body* belonging to someone not in the thread, and the same people
  arriving in a *different order*.
- **Scrub the body, not just the field.** The first draft pseudonymised author names and left
  message text alone. Phone numbers are shared *in messages* — that is the whole point of
  sharing them — so the version that only rewrote the author seat protected nothing anyone
  would care about.
- **Match the primitive, not the spelling.** `+91 98765 43210`, `+919876543210` and
  `(555) 123-4567` are one fact in three costumes. A pattern per costume is a list that is
  always one costume short.
- **Invisible characters are a real parser bug.** WhatsApp's iOS export writes bidi control
  marks (U+200E) before the bracket and a narrow no-break space (U+202F) before AM/PM. They
  are invisible in every editor, so a parser anchored on a literal `[` matches *nothing* and
  reports an empty export — and the "bug report" is a user saying the file didn't work.
- **The multiline bug is the dangerous one because it does not crash.** A continuation line
  treated as its own message inflates that person's message count and deflates their average
  length, and every downstream statistic and profile is then confidently wrong. Silent
  corruption beats loud failure every time, which is why it needs its own fixture.
- **Run the DDL against real sql.js once.** A mocked bridge accepts identifiers the real
  engine refuses. Four `CREATE TABLE`s and every runtime statement were executed against
  sql.js 1.14.1 before this shipped.
- **`node --test` and a hand-rolled mutation loop disagree about shell quoting.** Two
  "surviving" mutants in the first pass were perl escaping failures, not survivals. A
  mutation harness must assert that the mutation actually *applied* — otherwise "no test
  failed" reads as "the guard is untested" when it means "the file was never edited".
