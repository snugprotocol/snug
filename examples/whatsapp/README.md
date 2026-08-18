# Telepath

Your WhatsApp, live, inside Snug — with an analyst who knows the room and drafts in your voice.
Telepath is the TASK-20260817 rebuild of the WhatsApp Twin POC (same connection, same wizard,
same privacy boundary — a real messaging surface around them).

**Desktop only.** The linked-device session lives in a local helper process
(`apps/whatsapp-sidecar`) that the Snug desktop shell spawns and reaches over a unix socket
(ADR-0032). A browser tab structurally cannot open that transport.

## What it does

- **A real chat surface.** Your conversations, sorted by recency, with avatars, previews,
  timestamps and unread badges; threads render text and photos (inline thumbnails, tap for
  full size within the transport cap). New messages appear while the app is open — the host
  long-polls the helper's hint stream and rings the frame (ADR-0034); every UI change still
  flows from a governed read.
- **Send, in your own hand or with a running start.** Type and send (each credentialed write
  passes the host's confirm gate, and every send is journaled). Or tap ✨ and Telepath drafts
  the reply in YOUR register — length, punctuation, and your measured emoji habits — into the
  composer for you to edit. Nothing is ever sent for you.
- **Analysis that compounds.** Tap 🧠 and the app pulls the full history from the helper (the
  implicit export — no file to save and upload), watermarks the newest message, and asks your
  configured model for the full profile: each person as their messages actually show them, the
  group's dynamics, your own voice in that room. Tap again later and it sends the PRIOR
  analysis plus only the delta since the watermark — cheaper, and the headline tells you what
  changed. Results are stored in the app's own database.
- **Charts.** A local, deterministic picture of the thread: who carries the conversation,
  when it is alive (hour of day, in your timezone), the week's rhythm, who answers fastest,
  your emoji signature, and the long arc of messages per month. Computed entirely in the app —
  none of it touches a model.

## The privacy boundary (unchanged from the Twin, now bidirectional)

The app shows real names and numbers — you already see them in WhatsApp. The MODEL never
does: before any LLM turn, every participant becomes a stable label (`YOU`, `P1`, `P2`…),
and JIDs and phone numbers are scrubbed from author seats AND message bodies (a number
shared inside a message is the common case). The label map is persisted in the app's
database, so `P2` keeps meaning the same person across every incremental run — and when an
answer comes back, the app maps labels to names locally, at render time. Analyses are stored
pseudonymised at rest. Photos never reach the model at all.

Under BYOK, the (pseudonymised) messages of people who never consented still reach your own
model provider under your key. That is your call to make; the scrub is what makes it a
defensible one.

## Honesty notes

- **WhatsApp's terms.** Linking automation to a personal WhatsApp account violates
  WhatsApp's terms of service, and accounts have been banned for it. The helper paces sends
  (≥1.2 s apart) as harm reduction, never as detection evasion.
- **History coverage.** WhatsApp pushes history in chunks and sometimes only *infers*
  completion. The thread header says so ("history coverage inferred") rather than
  pretending the record is complete.
- **No unattended sends.** Auto-reply is not part of this app. The platform's standing
  approval gate (ADR-0033) exists, unarmed; Telepath ships manual send only.
- **Unread badges** clear locally when you open a thread. Telepath never sends read
  receipts on your behalf.

## Running it

1. Install the helper once: `pnpm --filter whatsapp-sidecar build && pnpm --filter whatsapp-sidecar install:helper`
   (Node 20+ must be on the GUI PATH — the app will tell you if it is not).
2. Install Telepath from the starter shelf in the Snug desktop app and follow the connection
   wizard: it starts the helper, shows the QR, and you scan it from WhatsApp's
   *Linked devices*. The wizard mints the helper access token itself — there is nothing to
   type or look up.
3. Open the app. The first read starts the helper if it is down; the list fills as history
   syncs from your phone.

## Data it keeps (in the app's own namespaced tables)

`threads` (watermarks + analysed-at) · `messages` (text cache the charts and deltas read —
never photos) · `pseudonyms` (the persisted label map) · `analyses` (every run, pseudonymised)
· `activity` (the send journal). "Forget" semantics: delete the app and its tables go with it.
