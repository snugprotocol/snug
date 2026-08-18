# Requirements

Telepath (TASK-20260817-telepath) rebuilds the WhatsApp Twin POC into a full client. The
owner's ten requirements, restated as what the app must do:

1. **Landing = the official WhatsApp shape.** Recent conversations sorted by latest
   activity, with avatar, name, last-message preview, timestamp, and an unread badge.
   Opening one loads the thread with recent messages including photos (images only in v1 —
   no voice/video/documents/stickers).
2. **Real names in the UI; labels to the model.** The app shows exactly the names/numbers
   WhatsApp shows. Before any LLM turn, every unique identity becomes a stable temp label
   (YOU/P1/P2…); the mapping is kept app-side (persisted in the app DB) and answers are
   mapped BACK to real names at render time. Names/numbers/JIDs never reach the model —
   from author seats or message bodies.
3. **Live ordering.** Threads and the list sort by recency; a message arriving while the
   app is open appears immediately (host push doorbell → governed refetch) and badges
   update per chat. Badge clears are local-only; no read receipts are ever sent.
4. **Draft-from-AI in the composer.** A ✨ button drafts the most natural reply on the
   user's behalf — their tone, their typical length, emoji chosen from their MEASURED
   historical usage — into the composer, editable, never auto-sent.
5. **Analyze on the thread.** A 🧠 button: the FIRST run implicitly pulls the full history
   from the helper (no export file to upload), records the newest message's timestamp as
   the watermark, and runs the full in-depth analysis (the Twin's knowledge base, carried
   forward). LATER runs fetch the prior analysis from the DB and send it plus ONLY the
   messages since the watermark. Results display with proper names (de-pseudonymised
   locally).
6. **The helper is always up on app load.** The mount-time read rides the transport that
   auto-starts the sidecar; failure states render a retry surface with the real reason.
7. **Charts tab.** Local, deterministic analytics per thread: share of messages per
   participant, activity by hour of day and weekday, median response times, the user's
   emoji signature, monthly volume trend. Computed in-app; never sent to a model.
8. **No auto-respond.** The POC's auto-reply surface is removed entirely. The platform's
   standing-approval gate (ADR-0033) stays where it is, unarmed.
9. **Docs in the DB.** Vision/requirements/plan/lessons — these files — seed
   `snug_app_docs` when the starter is installed (ADR-0035), so the installed app carries
   its own wiki.
10. **The build prompt in the DB too.** The verbatim owner prompt that drove this rebuild
    ships in `authoring/prompts/` and seeds a `build-prompt` doc at install.

**Hard boundaries:** desktop-only (the unix-socket transport); images capped by the 1 MiB
transport class (refused-with-thumbnail beyond it, never truncated); the LLM payload
byte-budgeted under the 256 KB frame class with truncation disclosed to the model; all
sidecar reads/writes through the governed connected-fetch seam — the app holds no token and
no address; sends pass the host's write-confirm gate and land in the activity journal.
