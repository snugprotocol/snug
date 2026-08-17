# Requirements

Single-file `app.html`; React + Babel from the fixed CDN allowlist; the embedded hooks block
byte-identical to `packages/sdk/embedded/snug-hooks.js`; no `<form>` (the sandbox blocks
submission before the event fires); no browser storage (null origin); no direct network — the
governed `useConnectedFetch` seam only.

## Surfaces

- **Threads** — list conversations from `GET snug-connection://whatsapp/chats`; pick exactly
  one. Show the history sync state honestly: `complete && explicit` is "this is everything",
  `complete && !explicit` must render as **partial** (completion was inferred from a timeout,
  not announced), and in-flight shows progress. An app that renders an inferred completion as
  the whole record is misdescribing the evidence the entire analysis rests on.
- **Export ingest** — paste a WhatsApp `Export chat` .txt. This is the reliability backstop,
  not a convenience: history sync can stall, and a full analysis must still be possible.
  Merge with live history, deduping on (text, minute) — the two sources name the same people
  differently (display name vs JID), so a naive concat double-counts every author.
- **Persona Lab** — the user's own voice card (tone, typical length, emoji signature, the
  language they usually reply in), one card per participant, and the group dynamics. Plus the
  **forget this thread** control, which cascades every table.
- **Insights** — thread shape (totals, people, busiest, average length) computed locally, and
  a question box answered by the model *from the saved rows only*.
- **Reply Desk** — manual **Reply** (draft → read it → send, never automatic) and the
  **auto-reply arm switch** (group: only messages tagging the user; DM: every new message),
  with an activity journal of every send.
- **Translate** — a per-message control shown only when the message's language differs from
  the app default; tap yields a translation cached per (thread, message, language). A
  default-language message must NOT offer it.
- **Settings** — the default language, and a plain statement of what leaves the machine.

## Non-negotiable

- **AC12 — pseudonymise before every model turn.** Participants become `P1`/`P2`/`YOU`;
  phone numbers and JIDs are stripped from the *body* as well as the author field. Labels are
  stable across turns (the model reasons about who answers whom) and distinct per person.
- **AC13 — the export parser handles what WhatsApp actually writes**: iOS bracketed, Android
  dashed, 12- and 24-hour, dot-separated locales, and bidi control characters (U+200E/U+202F)
  which silently defeat a parser anchored on a literal `[`. Multiline bodies attach to their
  parent. System lines, `<Media omitted>` and deletion tombstones never become messages. An
  unparseable upload yields zero messages and a count, never an exception.
- Export-derived (display name) and live-derived (JID) identities are never silently merged —
  two people sharing a display name are two people.
- Every model reply is validated locally before it touches state; off-script degrades
  visibly and saves nothing.
- ToS/ban-risk copy on the surface where the user acts, not only in the README.
- The DDL runs against real sql.js before shipping (a mocked bridge accepts identifiers the
  real engine refuses).
