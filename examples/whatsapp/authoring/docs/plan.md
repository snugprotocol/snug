# Plan / Architecture

## Connected API

Four app-reachable routes, all addressed symbolically (ADR-0026) so the app never learns
where the helper lives:

| Call | Route |
|---|---|
| list conversations | `GET snug-connection://whatsapp/chats` |
| buffered history + sync state | `GET snug-connection://whatsapp/chats/<jid>/history` |
| new messages | `GET snug-connection://whatsapp/chats/<jid>/messages` |
| send | `POST snug-connection://whatsapp/chats/<jid>/messages` — body `{ text }` |

`/pair/*` and `/session/status` are **wizard-only** and refused in Rust on the app path. They
are how a token comes into existence; an app able to poll them could mint itself a credential
without ever breaking the credential store. The app must never call them.

Every response goes through the three-level check the other connected starters use: `!ok`
(transport/permission, keyed on `error.code`), then `status >= 400` (the provider refused),
then parse. `NET_FETCH_FAILED` here almost always means "the helper is not running", which
gets its own words rather than a generic failure.

## Persistence

Four tables, created with `CREATE TABLE IF NOT EXISTS` on `isReady`, failures non-fatal:

- `threads(jid PK, name, is_group, analysed_at)` — what was analysed and when.
- `persona(jid, kind, label, payload, created_at)`, PK `(jid, kind, label)` — `kind` is
  `person` | `dynamics` | `voice`. Re-analysis `DELETE`s the thread's rows first, so profiles
  are replaced rather than accumulated (a stale profile beside a fresh one is worse than none).
- `translations(jid, message_id, language, text)`, PK all three — a tapped translation is
  paid for once.
- `activity(id, jid, at, incoming, outgoing, mode)` — the ADR-0033 §4 journal. `mode` is
  `manual` | `auto`.

`forget this thread` deletes from all four.

## The analysis pipeline

1. **Merge** live history with the parsed export, dedup on `(text, minute)`, sort by time.
2. **Pseudonymise** — `buildPseudonymMap` assigns `YOU` to the user's own messages and sorted,
   stable `P1…Pn` to everyone else; `pseudonymizeForLlm` rewrites author fields and redacts
   identifiers inside message bodies. Only then does anything reach the model.
3. **`profile_thread`** returns people + dynamics + the user's voice profile; validated,
   then written to `persona`.
4. **`answer_question`** reads the stored rows, never the raw transcript — the questions are
   about the analysis, so grounding them in the analysis is both cheaper and more honest.
5. **`draft_reply`** takes the voice profile and recent (pseudonymised) context and writes in
   the user's own language for that thread, whatever the UI language is.

## The scrub, and why it is a separate function

`scrubAuthValues` in `packages/auth` protects a *different reader*: it strips injected
credentials on the way into the iframe. Here the reader is a third-party LLM and the thing
worth protecting is other people's identities, so the scrub is re-derived at this reader's
altitude (lessons.md:40). Phone numbers are matched on the **primitive** — a dialable run of
digits, however spaced, dotted or bracketed — because the adversary is formatting, not an
attacker: `+91 98765 43210` and `+919876543210` are the same fact, and catching one spelling
protects nobody. Runs shorter than 7 digits are left alone, or the scrub would eat every
price and time and gut the text the analysis exists to read.

## Degradation

No connection → the connect CTA. Helper not running → "Twin works in the desktop app, with
the helper started". Sync partial → said out loud, with the export path offered. Model
off-script → a visible notice and nothing saved. DB write fails after a successful send →
the send still happened, and the UI must not imply otherwise.
