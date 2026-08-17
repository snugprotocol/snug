# build prompt — 2026-08-16, authored by Claude (Opus 5) for TASK-20260816-whatsapp-twin

Phase E of the task. The connection path (protocol kind, registry entry, sidecar package,
Rust commands, wizard flow) had already landed in phases A/B.0/B/C/G/D; this prompt covers
the starter app itself, written against those shipped seams rather than against a design.

===BRIEF-START===
Build `examples/whatsapp/` — the starter app for the `whatsapp` linked-device connection.
Display name **"WhatsApp Twin"** (owner-ratified 2026-08-16). Single-file `app.html` in the
house style: React + Babel from the CDN allowlist, the embedded hooks block copied
byte-identical from `packages/sdk/embedded/snug-hooks.js`, no `<form>`, no browser storage,
no direct network.

Five surfaces:

1. **Threads** — list chats, pick ONE. Render the history sync state honestly: an
   `explicit:false` completion is PARTIAL, never "everything".
2. **Export ingest** — paste a WhatsApp `Export chat` .txt; merge with live history. This is
   the reliability backstop for stalled sync, not a convenience.
3. **Persona Lab** — the user's own voice card, a card per participant, group dynamics, and a
   "forget this thread" control that cascades every table.
4. **Insights** — locally computed thread stats plus a question box answered from the stored
   analysis rows.
5. **Reply Desk** — manual Reply (draft, read, send) and the auto-reply arm switch (group:
   tagged only; DM: everything), with an activity journal of every send. Plus a per-message
   translate control and a default-language setting.

CRITICAL ADDRESSING RULE: reach the helper only through the symbolic scheme
(`snug-connection://whatsapp/...`), and only the four app-reachable routes —
`GET /chats`, `GET /chats/:jid/history`, `GET /chats/:jid/messages`, `POST /chats/:jid/messages`.
`/pair/*` and `/session/status` are wizard-only and refused in Rust; do not call them.

TWO NON-NEGOTIABLES, both with tests before the code:

- **AC12** — pseudonymise before EVERY model turn. Participants become P1/P2/YOU; phone
  numbers and JIDs are stripped from message bodies as well as author fields; labels are
  stable across turns and distinct per person. The load-bearing negative drives a real-shaped
  export containing a phone number through the real parser and asserts no fragment of it
  appears in the LLM request body.
- **AC13** — the export parser handles iOS bracketed, Android dashed, US 12-hour,
  dot-separated locale and bidi-prefixed (U+200E/U+202F) shapes; multiline bodies attach to
  their parent; system lines, `<Media omitted>` and deletion tombstones never become
  messages; a body containing a timestamp-shaped line stays one message; an unparseable blob
  yields zero messages rather than throwing.

Un-connected, helper-not-running, partial-sync and model-off-script states all get honest,
distinct copy — never a generic failure. ToS and ban-risk disclosure goes on the surface
where the user acts, not only in the README.
===BRIEF-END===
