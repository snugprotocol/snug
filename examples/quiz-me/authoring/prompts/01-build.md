*Reconstructed retrospectively (2026-08-21, TASK-20260821-hardening-polish): no verbatim prompt provenance exists for this starter — this page describes the build brief its code implies, so app-attached chat has honest context.*

# Build prompt — Quiz Me

- **Original build:** 2026-08-06, TASK-20260806-starters-pillars (one of the five
  pillar starters; hardened the same day in the adversarial-review round)
- **This page:** a reconstruction, labelled above — not an owner quote

The brief the code implies:

---

Build the education pillar of the starter shelf: a quiz app where a kid picks any
topic — a few preset chips plus a free-typed one — and the agent writes them a
five-question multiple-choice quiz on the spot, with a fun fact behind every
answer. You are to keep the roles strict: the agent only WRITES questions; the app
grades, keeps score and owns the flow. Demand an exact reply shape (five
questions, four choices, one correct index) and reject anything that doesn't
match it completely — never trust a partial reply.

It must be fully playable with no LLM configured: ship a built-in practice bank
that steps in whenever the agent's reply fails validation, and say so on screen
rather than pretending. Keep every finished score in a real SQLite table in the
user's own file and show a small history of past rounds, so progress belongs to
the family, not a service.

Make it kid-first: one question at a time, big friendly buttons, instant feedback,
encouraging results copy, both themes. Single file, embedded hooks, no network —
the standard starter constraints apply.
