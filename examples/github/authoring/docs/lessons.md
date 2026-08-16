# Lessons

- (2026-08-15, real-browser design pass) `DEFERRABLE` is an SQLite reserved word — the
  briefings table's CREATE failed with a syntax error that every mocked-bridge check
  missed, and only a real host + real sql.js surfaced ("storage hiccup" in the UI). SQL
  identifiers get checked against the reserved-word list; the agent-reply field name
  stays `deferrable` (JS is not SQL).
